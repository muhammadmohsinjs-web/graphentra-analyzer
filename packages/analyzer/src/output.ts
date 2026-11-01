import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidEvidenceEnvelope } from './validator';
import { renderCoverageMarkdown } from './coverage';
import type {
  AnalyzeResult,
  ChangedFile,
  DiagnosticItem,
  DeterministicEvidence,
  Entity,
  EntityImpact,
  ImpactPath,
  RelationType,
  TechnicalGraph,
} from './contracts';

export const DEFAULT_LIMITATIONS = [
  'Only TypeScript is analyzed.',
  'Only named standalone function declarations are supported.',
  'Only CALLS relationships are currently supported.',
  'Class methods are not analyzed.',
  'Arrow functions are not analyzed.',
  'Dynamic calls are not analyzed.',
  'Deleted functions have no current graph entity; renamed or ambiguous functions may lack removed-code evidence.',
  'Overlapping function line ranges are skipped rather than sharing ambiguous evidence.',
  'Application surfaces are not yet discovered.',
  'Blast radius is limited to depth 6.',
];

export const EXTENDED_LIMITATIONS = [
  'Only TypeScript and JavaScript are analyzed; JavaScript is not type-checked.',
  'Entities are named functions, variable-bound arrow functions and function expressions, class and object-literal methods, constructors, accessors, React components, and module-level code.',
  'Classes, interfaces, type aliases, and enums are not entities.',
  'Relationships are CALLS, RENDERS (JSX elements), INSTANTIATES (new expressions), and REFERENCES (functions passed or stored as values).',
  'Dynamic calls and calls through interface-typed receivers are not analyzed.',
  'Renamed entities may lack removed-code evidence.',
  'Partially overlapping entity line ranges are skipped rather than sharing ambiguous evidence.',
  'Application surfaces are not yet discovered.',
  'Blast radius is limited to depth 6.',
];

export function printChangedFile(change: ChangedFile): void {
  console.log('\n----------------------------------------');
  console.log(`📄 ${change.file}`);
  console.log('----------------------------------------');
  console.log(`Changed lines: ${change.changedLines.join(', ')}`);

  if (change.removedCode.length > 0) {
    console.log('\nRemoved:');
    for (const line of change.removedCode) {
      console.log(`- ${line}`);
    }
  }

  if (change.addedCode.length > 0) {
    console.log('\nAdded:');
    for (const line of change.addedCode) {
      console.log(`+ ${line}`);
    }
  }
}

/**
 * Atomically writes a JSON artifact using a temporary file in the destination
 * directory followed by an atomic rename.
 */
export function writeJsonArtifact(
  directory: string,
  fileName: string,
  value: unknown,
): string {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  const tempPath = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  }
  return filePath;
}

export function writeEvidenceFile(filePath: string, evidence: unknown): string {
  assertValidEvidenceEnvelope(evidence);
  return writeJsonArtifact(path.dirname(filePath), path.basename(filePath), evidence);
}

/**
 * Atomically writes a Markdown report using a temporary file followed by an atomic rename.
 */
export function writeMarkdownReport(reportPath: string, content: string): void {
  const dir = path.dirname(reportPath);
  fs.mkdirSync(dir, { recursive: true });
  const baseName = path.basename(reportPath);
  const tempPath = path.join(dir, `.${baseName}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${content.trim()}\n`, 'utf8');
    fs.renameSync(tempPath, reportPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

/** Reads a path step backwards: in `a → called by b`, b has a relation of this type to a. */
export const STEP_LABELS: Record<RelationType, string> = {
  CALLS: 'called by',
  RENDERS: 'rendered by',
  INSTANTIATES: 'constructed by',
  REFERENCES: 'referenced by',
};
/** Typed paths printed per impact; the rest are summarized as a count. */
export const MAX_REPORTED_PATHS = 10;
/** Frontier sites listed in "Where analysis stopped"; the rest are summarized as a count. */
export const MAX_REPORTED_FRONTIER = 30;
/** D11 classes in precedence order; their diagnostics are listed grouped by class. */
export const NON_TS_CLASSES = ['DEPENDENCY_CHANGE', 'SCHEMA_CHANGE', 'ENV_CONFIG_CHANGE', 'CI_CONFIG_CHANGE', 'ASSET_ONLY', 'OTHER'] as const;

/** Formats a typed path, e.g. "`OrderRow` → rendered by `OrderList` → rendered by `OrdersPage`". */
export function formatTypedPath(path: ImpactPath): string {
  // Module entities are all named `<module>`, so name the file too.
  const name = (entity: Entity) => `\`${entity.name === '<module>' ? `<module> (${entity.file})` : entity.name}\``;
  return path.path
    .map((entity, i) => (i === 0 ? name(entity) : `${STEP_LABELS[path.stepTypes![i - 1]]} ${name(entity)}`))
    .join(' → ');
}

export function formatDeterministicMarkdown(result: AnalyzeResult): string {
  const lines: string[] = [
    '# Graphentra Deterministic Analysis Report',
    '',
    `**Outcome:** \`${result.outcome}\``,
    '',
    `**Summary:** ${result.summaryMessage}`,
    '',
  ];

  if (result.changedEntities.length > 0) {
    lines.push('## Changed Functions', '');
    for (const changed of result.changedEntities) {
      lines.push(`- \`${changed.entity.id}\` (lines ${changed.entity.startLine}–${changed.entity.endLine})`);
    }
    lines.push('');
  }

  if (result.impacts.length > 0) {
    lines.push('## Impacts and Blast Radius', '');
    // Extended evidence carries a path confidence; legacy impacts have none and stay a flat list.
    const grouped = result.impacts.some(impact => impact.confidence !== undefined);
    const groups: Array<{ title?: string; heading: string; impacts: EntityImpact[] }> = grouped
      ? [{ title: 'Proven impact', heading: '####', impacts: result.impacts.filter(impact => impact.confidence !== 'likely') },
         { title: 'Likely impact', heading: '####', impacts: result.impacts.filter(impact => impact.confidence === 'likely') }]
      : [{ heading: '###', impacts: result.impacts }];
    for (const group of groups) {
      if (group.title !== undefined) {
        if (group.impacts.length === 0) continue;
        lines.push(`### ${group.title}`, '');
      }
      for (const impact of group.impacts) {
        lines.push(`${group.heading} \`${impact.changedEntity.id}\``);
        lines.push(`- Direct dependents: ${impact.directDependents.length}`);
        lines.push(`- Total affected entities: ${impact.blastRadius.totalAffectedEntities}`);
        lines.push(`- Terminal dependents: ${impact.terminalDependents.length}`);
        for (const hub of impact.blastRadius.hubs ?? []) {
          lines.push(hub.entityId === impact.changedEntity.id
            ? `- Changed a hub used by ${hub.fanIn} callers (reach ${hub.reach})`
            : `- Traversal stopped at hub \`${hub.entityId}\` used by ${hub.fanIn} callers (reach ${hub.reach})`);
        }
        if (impact.directDependents.length > 0) {
          lines.push('  - Direct: ' + impact.directDependents.map(d => `\`${d.id}\``).join(', '));
        }
        // Extended evidence only: legacy paths carry no step types, so legacy reports are unchanged.
        const typed = impact.blastRadius.paths.filter(path => path.stepTypes);
        if (typed.length > 0) {
          const terminalIds = new Set(impact.terminalDependents.map(entity => entity.id));
          const shown = [...typed]
            .sort((a, b) => Number(terminalIds.has(b.target.id)) - Number(terminalIds.has(a.target.id)) || b.depth - a.depth)
            .slice(0, MAX_REPORTED_PATHS);
          lines.push('- Paths:');
          for (const path of shown) lines.push(`  - ${formatTypedPath(path)}`);
          if (typed.length > shown.length) lines.push(`  - …and ${typed.length - shown.length} more`);
          const likelyPaths = typed.filter(path => path.confidence === 'likely').length;
          if (likelyPaths > 0) lines.push(`- Likely paths: ${likelyPaths} of ${typed.length} (an edge goes through an interface, overload or callback)`);
        }
        lines.push('');
      }
    }
  }

  const frontier = result.evidence.frontier ?? [];
  if (frontier.length > 0) {
    lines.push('## Where analysis stopped', '');
    for (const item of frontier.slice(0, MAX_REPORTED_FRONTIER)) lines.push(`- ${item.file}:${item.line} ${item.reason}`);
    if (frontier.length > MAX_REPORTED_FRONTIER) lines.push(`- and ${frontier.length - MAX_REPORTED_FRONTIER} more`);
    lines.push('');
  }

  const nonTs = new Set<string>(NON_TS_CLASSES);
  const nonTsDiagnostics = result.diagnostics.filter(diagnostic => typeof diagnostic !== 'string' && nonTs.has(diagnostic.code));
  if (nonTsDiagnostics.length > 0) {
    lines.push('## Non-TypeScript changes', '');
    for (const code of NON_TS_CLASSES) {
      const items = nonTsDiagnostics.filter(diagnostic => diagnostic.code === code);
      if (items.length === 0) continue;
      lines.push(`### ${code}`, '');
      for (const item of items) lines.push(`- ${item.file ?? '(unknown file)'}: ${item.message}`);
      lines.push('');
    }
  }

  const generalDiagnostics = result.diagnostics.filter(diagnostic => !nonTsDiagnostics.includes(diagnostic));
  if (generalDiagnostics.length > 0) {
    lines.push('## Diagnostics', '');
    for (const diagnostic of generalDiagnostics) {
      const msg = typeof diagnostic === 'string' ? diagnostic : `[${diagnostic.severity.toUpperCase()}] ${diagnostic.code}: ${diagnostic.message}`;
      lines.push(`- ${msg}`);
    }
    lines.push('');
  }

  if (result.evidence.coverage) lines.push(renderCoverageMarkdown(result.evidence.coverage).trimEnd(), '');

  if (result.evidence.limitations.length > 0) {
    lines.push('## Limitations', '');
    for (const limitation of result.evidence.limitations) {
      lines.push(`- ${limitation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
