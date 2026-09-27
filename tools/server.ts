#!/usr/bin/env node
// Minimal QA report sharing server. Intentionally simple: no auth, no framework, SQLite file storage.
import { createServer, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { config } from 'dotenv';
import { DEFAULT_OPENROUTER_MODEL, generateQAReport } from '@graphentra/reporting';

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

const llmOptions = {
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
  logLevel: 'off' as const,
};

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, resource, id, format] = url.pathname.split('/');
    if (resource !== 'reports') return send(res, 404, { error: 'not found' });

    // POST /reports  body: { evidence, applicationContext }
    if (req.method === 'POST' && !id) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { evidence, applicationContext } = JSON.parse(raw);
      if (!evidence || !applicationContext) return send(res, 400, { error: 'evidence and applicationContext are required' });
      const report = await generateQAReport(evidence, applicationContext, llmOptions);
      const row = db.prepare(`INSERT INTO reports
        (evidence_identity, evidence, technical_graph, application_context, qa_report, markdown)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        report.evidenceIdentity,
        JSON.stringify(evidence),
        JSON.stringify(evidence.technicalGraph),
        JSON.stringify(applicationContext),
        JSON.stringify(report.qaReport),
        report.markdownReport,
      );
      return send(res, 201, { id: Number(row.lastInsertRowid), evidenceIdentity: report.evidenceIdentity, qaReport: report.qaReport });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    // GET /reports
    if (!id) {
      return send(res, 200, db.prepare(`SELECT id, created_at, evidence_identity,
        json_extract(qa_report, '$.summary') AS summary FROM reports ORDER BY id DESC`).all());
    }

    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!row) return send(res, 404, { error: 'not found' });

    // GET /reports/:id/md
    if (format === 'md') return send(res, 200, row.markdown, 'text/markdown; charset=utf-8');

    // GET /reports/:id  (JSON columns parsed back to objects)
    return send(res, 200, {
      id: row.id,
      createdAt: row.created_at,
      evidenceIdentity: row.evidence_identity,
      qaReport: JSON.parse(row.qa_report),
      markdown: row.markdown,
      evidence: JSON.parse(row.evidence),
      technicalGraph: JSON.parse(row.technical_graph),
      applicationContext: JSON.parse(row.application_context),
    });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`Graphentra report server on http://localhost:${port}/reports`));
