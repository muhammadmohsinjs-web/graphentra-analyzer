import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidEvidenceEnvelope } from './validator';
import type {
  AnalyzeResult,
  ChangedFile,
  DiagnosticItem,
  DeterministicEvidence,
  Entity,
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
    for (const impact of result.impacts) {
      lines.push(`### \`${impact.changedEntity.id}\``);
      lines.push(`- Direct dependents: ${impact.directDependents.length}`);
      lines.push(`- Total affected entities: ${impact.blastRadius.totalAffectedEntities}`);
      lines.push(`- Terminal dependents: ${impact.terminalDependents.length}`);
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
      }
      lines.push('');
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push('## Diagnostics', '');
    for (const diagnostic of result.diagnostics) {
      const msg = typeof diagnostic === 'string' ? diagnostic : `[${diagnostic.severity.toUpperCase()}] ${diagnostic.code}: ${diagnostic.message}`;
      lines.push(`- ${msg}`);
    }
    lines.push('');
  }

  if (result.evidence.limitations.length > 0) {
    lines.push('## Limitations', '');
    for (const limitation of result.evidence.limitations) {
      lines.push(`- ${limitation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
