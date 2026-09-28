#!/usr/bin/env node
// Minimal QA report sharing server. Intentionally simple: no auth, no framework, SQLite file storage.
//
// Two audiences:
// - QA (default responses): the QA report plus business-friendly change info (who, which PR, which branch).
// - Engineers (GET /reports/:id/technical): the stored evidence, graph, application context and map.
import { createServer, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { config } from 'dotenv';
import { z } from 'zod';
import type { ApplicationMap } from '@graphentra/analyzer';
import { DEFAULT_OPENROUTER_MODEL, formatImpactReport, generateQAReport, type ImpactReport } from '@graphentra/reporting';

config({ path: ['.env'], quiet: true });

const db = new DatabaseSync(process.env.DB_PATH ?? 'reports.db');
db.exec(`CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  evidence_identity TEXT,
  evidence TEXT,
  technical_graph TEXT,
  application_context TEXT,
  qa_report TEXT,
  markdown TEXT
)`);

// Columns added after the first version. Added in place so existing reports.db files keep working.
const addedColumns: Record<string, string> = {
  application_map: 'TEXT',
  repository: 'TEXT',
  branch: 'TEXT',
  base_branch: 'TEXT',
  commit_sha: 'TEXT',
  commit_message: 'TEXT',
  author_name: 'TEXT',
  author_email: 'TEXT',
  pr_number: 'INTEGER',
  pr_title: 'TEXT',
  pr_url: 'TEXT',
  change_info: 'TEXT',
  model: 'TEXT',
};
const existingColumns = new Set((db.prepare('PRAGMA table_info(reports)').all() as Array<{ name: string }>).map(column => column.name));
for (const [name, type] of Object.entries(addedColumns)) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS reports_repository_pr ON reports (repository, pr_number)');

const llmOptions = {
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
  baseURL: process.env.OPENROUTER_BASE_URL,
  logLevel: 'off' as const,
};

const text = (max: number) => z.string().trim().min(1).max(max);
const person = z.object({ name: text(200).optional(), email: text(320).optional(), login: text(200).optional() }).strict();

/** Business-facing description of the change. Everything is optional; the caller sends what it knows. */
const changeInfoSchema = z.object({
  repository: text(300).optional(),
  branch: text(300).optional(),
  baseBranch: text(300).optional(),
  commit: z.object({
    sha: text(64).optional(),
    message: text(2000).optional(),
    committedAt: text(64).optional(),
    url: z.url().max(2000).optional(),
  }).strict().optional(),
  author: person.optional(),
  pullRequest: z.object({
    number: z.number().int().positive().optional(),
    title: text(500).optional(),
    url: z.url().max(2000).optional(),
    author: person.optional(),
    description: z.string().max(10000).optional(),
    labels: z.array(text(100)).max(50).optional(),
  }).strict().optional(),
}).strict();
type ChangeInfo = z.infer<typeof changeInfoSchema>;

const requestSchema = z.object({
  evidence: z.record(z.string(), z.unknown()),
  applicationContext: z.record(z.string(), z.unknown()),
  applicationMap: z.record(z.string(), z.unknown()).optional(),
  change: changeInfoSchema.optional(),
});

const MAX_BODY_BYTES = 20 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** What QA sees: the checklist, without surface IDs or other analyzer internals. */
function qaView(report: ImpactReport) {
  return {
    summary: report.summary,
    keyChanges: report.keyChanges,
    testAreas: (report.testAreas ?? []).map(({ area, howToReach, access, setup, checks }) => ({ area, howToReach, access, setup, checks })),
    qaChecks: report.qaChecks,
    openQuestions: report.uncertainty,
  };
}

function changeMarkdown(change: ChangeInfo): string {
  const pr = change.pullRequest;
  const rows: Array<[string, string | undefined]> = [
    ['Pull request', pr ? [pr.number ? `#${pr.number}` : undefined, pr.title].filter(Boolean).join(' ') + (pr.url ? ` (${pr.url})` : '') : undefined],
    ['Repository', change.repository],
    ['Branch', change.branch && change.baseBranch ? `${change.branch} → ${change.baseBranch}` : change.branch],
    ['Changed by', change.author?.name ?? change.author?.login ?? pr?.author?.name ?? pr?.author?.login],
    ['Commit', change.commit?.message ? `${change.commit.message.split('\n')[0]}${change.commit.sha ? ` (${change.commit.sha.slice(0, 7)})` : ''}` : change.commit?.sha?.slice(0, 7)],
  ];
  const lines = rows.filter(([, value]) => value).map(([label, value]) => `- **${label}:** ${value}`);
  return lines.length ? `## Change\n\n${lines.join('\n')}\n\n` : '';
}

function qaMarkdown(change: ChangeInfo, report: ImpactReport): string {
  const title = change.pullRequest?.title ? `QA Report: ${change.pullRequest.title}` : 'QA Report';
  return `# ${title}\n\n${changeMarkdown(change)}## What to test\n\n${formatImpactReport(report)}\n`;
}

type Row = Record<string, string | number | null>;

function changeFromRow(row: Row): ChangeInfo {
  return row.change_info ? JSON.parse(String(row.change_info)) : {};
}

function listItem(row: Row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    repository: row.repository,
    branch: row.branch,
    pullRequest: row.pr_number || row.pr_title ? { number: row.pr_number, title: row.pr_title, url: row.pr_url } : null,
    changedBy: row.author_name,
    commitMessage: row.commit_message,
    summary: row.summary,
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, resource, id, format] = url.pathname.split('/');
    if (resource !== 'reports') return send(res, 404, { error: 'not found' });

    // POST /reports  body: { evidence, applicationContext, applicationMap?, change? }
    if (req.method === 'POST' && !id) {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) return send(res, 413, { error: 'request body too large' });
      }
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'request body must be JSON' }); }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        return send(res, 400, { error: 'invalid request', issues: parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`) });
      }
      const { evidence, applicationContext, applicationMap } = parsed.data;
      const change: ChangeInfo = parsed.data.change ?? {};
      if (evidence.outcome !== 'completed') {
        return send(res, 422, { error: `no QA report needed: analysis outcome is "${String(evidence.outcome)}"` });
      }

      // The application map lets the report say which page/endpoint to open and how to get there.
      const report = await generateQAReport(evidence, applicationContext, llmOptions, {
        applicationMap: applicationMap as ApplicationMap | undefined,
      });
      const markdown = qaMarkdown(change, report.qaReport);
      const row = db.prepare(`INSERT INTO reports
        (evidence_identity, evidence, technical_graph, application_context, application_map, qa_report, markdown,
         repository, branch, base_branch, commit_sha, commit_message, author_name, author_email, pr_number, pr_title, pr_url, change_info, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        report.evidenceIdentity,
        JSON.stringify(evidence),
        JSON.stringify(evidence.technicalGraph),
        JSON.stringify(applicationContext),
        applicationMap ? JSON.stringify(applicationMap) : null,
        JSON.stringify(report.qaReport),
        markdown,
        change.repository ?? null,
        change.branch ?? null,
        change.baseBranch ?? null,
        change.commit?.sha ?? null,
        change.commit?.message?.split('\n')[0] ?? null,
        change.author?.name ?? change.pullRequest?.author?.name ?? change.author?.login ?? change.pullRequest?.author?.login ?? null,
        change.author?.email ?? null,
        change.pullRequest?.number ?? null,
        change.pullRequest?.title ?? null,
        change.pullRequest?.url ?? null,
        JSON.stringify(change),
        llmOptions.model,
      );
      return send(res, 201, { id: Number(row.lastInsertRowid), change, qaReport: qaView(report.qaReport) });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    // GET /reports[?repository=org/repo&pr=42&branch=feature-x]
    if (!id) {
      const filters: string[] = [];
      const values: Array<string | number> = [];
      const repository = url.searchParams.get('repository');
      const pr = url.searchParams.get('pr');
      const branch = url.searchParams.get('branch');
      if (repository) { filters.push('repository = ?'); values.push(repository); }
      if (pr) { filters.push('pr_number = ?'); values.push(Number(pr)); }
      if (branch) { filters.push('branch = ?'); values.push(branch); }
      const rows = db.prepare(`SELECT id, created_at, repository, branch, author_name, commit_message, pr_number, pr_title, pr_url,
        json_extract(qa_report, '$.summary') AS summary FROM reports
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY id DESC`).all(...values) as Row[];
      return send(res, 200, rows.map(listItem));
    }

    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as Row | undefined;
    if (!row) return send(res, 404, { error: 'not found' });

    // GET /reports/:id/md  (readable QA report)
    if (format === 'md') return send(res, 200, String(row.markdown), 'text/markdown; charset=utf-8');

    // GET /reports/:id/technical  (for engineers; not for the QA dashboard)
    if (format === 'technical') {
      return send(res, 200, {
        id: row.id,
        evidenceIdentity: row.evidence_identity,
        model: row.model,
        evidence: JSON.parse(String(row.evidence)),
        technicalGraph: JSON.parse(String(row.technical_graph)),
        applicationContext: JSON.parse(String(row.application_context)),
        applicationMap: row.application_map ? JSON.parse(String(row.application_map)) : null,
        qaReport: JSON.parse(String(row.qa_report)),
      });
    }
    if (format) return send(res, 404, { error: 'not found' });

    // GET /reports/:id  (QA view)
    return send(res, 200, {
      id: row.id,
      createdAt: row.created_at,
      change: changeFromRow(row),
      qaReport: qaView(JSON.parse(String(row.qa_report))),
      markdown: row.markdown,
    });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`Graphentra report server on http://localhost:${port}/reports`));
