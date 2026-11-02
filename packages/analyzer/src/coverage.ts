import type { CoverageRow, DeterministicEvidence, SkipReason } from './contracts';
import { compareStrings } from './deterministic';

type Coverage = NonNullable<DeterministicEvidence['coverage']>;

export interface CoverageInput {
  changedFiles: Array<{ file: string; changedLines: number[] }>;
  attributedLines: Map<string, Set<number>>;
  frontier: Array<{ file: string }>;
  skipped: Array<{ file: string; reason: SkipReason }>;
  frontierTotal: number;
}

/** Extension to language key. Explicit and sorted by extension. */
export const LANGUAGE_BY_EXTENSION: ReadonlyArray<readonly [string, string]> = [
  ['.bash', 'shell'],
  ['.cjs', 'javascript'],
  ['.cs', 'csharp'],
  ['.css', 'css'],
  ['.cts', 'typescript'],
  ['.go', 'go'],
  ['.htm', 'html'],
  ['.html', 'html'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.json', 'json'],
  ['.jsx', 'javascript'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.less', 'css'],
  ['.markdown', 'markdown'],
  ['.md', 'markdown'],
  ['.mdx', 'markdown'],
  ['.mjs', 'javascript'],
  ['.mts', 'typescript'],
  ['.php', 'php'],
  ['.prisma', 'prisma'],
  ['.py', 'python'],
  ['.pyi', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.scss', 'css'],
  ['.sh', 'shell'],
  ['.sql', 'sql'],
  ['.swift', 'swift'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.zsh', 'shell'],
];
const LANGUAGE_MAP = new Map(LANGUAGE_BY_EXTENSION);

export function languageOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'other';
  return LANGUAGE_MAP.get(base.slice(dot).toLowerCase()) ?? 'other';
}

/** First path segment, or `.` for files at the repo root. */
export function directoryOf(file: string): string {
  const slash = file.indexOf('/');
  return slash < 0 ? '.' : file.slice(0, slash);
}

/** Maps a source-snapshot skip reason to an evidence SkipReason. */
export function mapSnapshotSkipReason(reason: string): SkipReason {
  switch (reason) {
    case 'binary': return 'binary';
    case 'invalid_encoding': return 'invalid_encoding';
    case 'symlink': return 'symlink';
    case 'too_large': return 'too_large';
    // input_limit has no evidence reason of its own; it is a size/count limit, so report it as too_large.
    case 'input_limit': return 'too_large';
    case 'parse_failed': return 'parse_failure';
    default: return 'unsupported_language';
  }
}

interface Acc { changed: number; attributed: number; frontier: number }

function buildRows(
  keyOf: (file: string) => string,
  input: CoverageInput,
): CoverageRow[] {
  const rows = new Map<string, Acc>();
  for (const changed of input.changedFiles) {
    const key = keyOf(changed.file);
    const acc = rows.get(key) ?? { changed: 0, attributed: 0, frontier: 0 };
    const lines = new Set(changed.changedLines);
    const attributed = input.attributedLines.get(changed.file);
    acc.changed += lines.size;
    if (attributed) for (const line of lines) if (attributed.has(line)) acc.attributed++;
    rows.set(key, acc);
  }
  // Frontier items only count toward rows that exist (rows come from changed files).
  for (const item of input.frontier) {
    const acc = rows.get(keyOf(item.file));
    if (acc) acc.frontier++;
  }
  return [...rows.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, acc]) => ({
      key,
      changedLines: acc.changed,
      attributedLines: acc.attributed,
      ratio: acc.changed === 0 ? 0 : Math.round((acc.attributed / acc.changed) * 10000) / 10000,
      frontierCount: acc.frontier,
    }));
}

export function buildCoverage(input: CoverageInput): Coverage {
  return {
    byLanguage: buildRows(languageOf, input),
    byDirectory: buildRows(directoryOf, input),
    skippedFiles: input.skipped
      .map(({ file, reason }) => ({ file, reason }))
      .sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.reason, b.reason)),
    frontierTotal: input.frontierTotal,
  };
}

const MAX_SKIPPED_LISTED = 50;

function table(title: string, rows: CoverageRow[]): string[] {
  const lines = [`### ${title}`, '', `| ${title.replace('Coverage by ', '')} | Changed lines | Attributed | Ratio | Frontier |`, '| --- | ---: | ---: | ---: | ---: |'];
  for (const r of rows) lines.push(`| ${r.key} | ${r.changedLines} | ${r.attributedLines} | ${r.ratio.toFixed(4)} | ${r.frontierCount} |`);
  if (rows.length === 0) lines.push('| none | 0 | 0 | 0.0000 | 0 |');
  return lines;
}

export function renderCoverageMarkdown(coverage: Coverage): string {
  const out = [
    '## Coverage',
    '',
    ...table('Coverage by language', coverage.byLanguage),
    '',
    ...table('Coverage by directory', coverage.byDirectory),
    '',
    `Frontier items: ${coverage.frontierTotal}`,
    '',
    '### Skipped files',
    '',
  ];
  if (coverage.skippedFiles.length === 0) out.push('None.');
  else {
    for (const s of coverage.skippedFiles.slice(0, MAX_SKIPPED_LISTED)) out.push(`- ${s.file} (${s.reason})`);
    const more = coverage.skippedFiles.length - MAX_SKIPPED_LISTED;
    if (more > 0) out.push(`- and ${more} more`);
  }
  return out.join('\n') + '\n';
}
