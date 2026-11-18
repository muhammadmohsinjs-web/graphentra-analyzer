import type { EntityImpact } from '@graphentra/analyzer';
import type { ImpactReport } from '../llm-client';
import { getSourceRole } from '../qa-evidence';

// Phase V (ADR-0011), V-5. Pure functions from finished evidence and report to the two yes/no question sets.
// U1 coverage and U3 faithfulness only: U2 (triggering input) failed the V-3 gate and was dropped.
// Wording and input format match the labelled set measured at V-3 (impactbench/verifier/), so its scores still apply.

export const CODE_CAP = 4000; // characters per side (BEFORE / AFTER) per change
export const EVIDENCE_CAP = 24000; // characters of change summaries for a faithfulness item
export const REPORT_CAP = 8000; // characters of rendered report
const USED_BY_PATHS = 3;

export const COVERAGE_QUESTION =
  'Look at the QA REPORT and the CHANGE (BEFORE is the old code, AFTER is the new code). Answer true if at least one key change, QA check or test area in the report describes or tests the behaviour that changed in this CHANGE. Answer false if the report never addresses this behaviour, or only mentions it as unrelated context.';
export const FAITHFULNESS_QUESTION =
  'Look at the CLAIM and the EVIDENCE (BEFORE is the old code, AFTER is the new code). Answer true only if the claim is supported by the code changes in the evidence and describes old and new behaviour the right way round. Answer false if the claim is not supported, describes a change that is not in the evidence, or swaps before and after.';
/** Added only when a PRIOR STATE section is present (the two V-3 misses called an old capability "new"). */
export const PRIOR_STATE_NOTE =
  ' The PRIOR STATE section lists what already existed before the change. Answer false if the claim calls something new, or newly possible, that the prior state already had.';

export type VerificationKind = 'coverage' | 'faithfulness';

export interface VerificationItem {
  /** Stable across runs for the same evidence and report: `coverage:<entityId>` or `faithfulness:<index>`. */
  id: string;
  kind: VerificationKind;
  /** Coverage: the changed entity. */
  entity?: string;
  /** Faithfulness: the key-change claim. */
  claim?: string;
  /** The yes/no question text. */
  instructions: string;
  /** Items with the same prefix are sent with the same cache key. */
  cacheGroup: string;
  /** The shared input for the question. */
  input: string;
}

export interface BuildQuestionsOptions {
  /**
   * Short description of what the touched code could already do before the change, keyed by changed entity id
   * (for example the previous exports of the module). Added to faithfulness evidence as PRIOR STATE.
   */
  priorState?: Record<string, string>;
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters cut]` : text);
const lines = (code: unknown) => (Array.isArray(code) ? code.join('\n') : typeof code === 'string' ? code : '');

export function renderReport(report: ImpactReport): string {
  const list = (items: string[] = []) => items.map((text, i) => `${i + 1}. ${text}`).join('\n') || '(none)';
  const areas = (report.testAreas ?? [])
    .map(a => `- ${a.area}${a.setup ? ` (setup: ${a.setup})` : ''}\n${(a.checks ?? []).map(c => `  * ${c}`).join('\n')}`)
    .join('\n');
  return cap(
    [
      'QA REPORT',
      `Summary: ${report.summary ?? ''}`,
      `Key changes:\n${list(report.keyChanges)}`,
      `QA checks:\n${list(report.qaChecks)}`,
      `Test areas:\n${areas || '(none)'}`,
      `Uncertainty:\n${list(report.uncertainty)}`,
    ].join('\n\n'),
    REPORT_CAP,
  );
}

export function renderChange(impact: EntityImpact, label = 'CHANGE'): string {
  const paths = impact.blastRadius.paths.slice(0, USED_BY_PATHS).map(p => p.path.map(e => e.name).join(' -> '));
  return [
    `${label} ${impact.changedEntity.id} (${impact.change.file})`,
    `BEFORE (removed code):\n${cap(lines(impact.change.removedCode), CODE_CAP) || '(nothing removed)'}`,
    `AFTER (added code):\n${cap(lines(impact.change.addedCode), CODE_CAP) || '(nothing added)'}`,
    paths.length ? `Used by:\n${paths.map(p => `- ${p}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** U1: one question per changed production entity. Changed test files are not asked about. */
export function buildCoverageItems(impacts: EntityImpact[], report: ImpactReport): VerificationItem[] {
  const reportText = renderReport(report);
  return impacts
    .filter(impact => getSourceRole(impact.changedEntity.file) === 'production')
    .map(impact => ({
      id: `coverage:${impact.changedEntity.id}`,
      kind: 'coverage' as const,
      entity: impact.changedEntity.id,
      instructions: COVERAGE_QUESTION,
      cacheGroup: 'coverage',
      // The report comes first and is identical for every entity, so the provider can cache that prefix.
      input: `${reportText}\n\n${renderChange(impact)}`,
    }));
}

/** U3: one question per key-change claim, asked against the evidence for the whole change set. */
export function buildFaithfulnessItems(impacts: EntityImpact[], report: ImpactReport, options: BuildQuestionsOptions = {}): VerificationItem[] {
  const prior = Object.entries(options.priorState ?? {})
    .filter(([entity]) => impacts.some(impact => impact.changedEntity.id === entity))
    .map(([entity, text]) => `- ${entity}: ${text}`);
  const evidence = cap(impacts.map(impact => renderChange(impact)).join('\n\n'), EVIDENCE_CAP);
  const evidenceBlock = `EVIDENCE\n${evidence}${prior.length ? `\n\nPRIOR STATE\n${prior.join('\n')}` : ''}`;
  return report.keyChanges.map((claim, index) => ({
    id: `faithfulness:${index}`,
    kind: 'faithfulness' as const,
    claim,
    instructions: prior.length ? `${FAITHFULNESS_QUESTION}${PRIOR_STATE_NOTE}` : FAITHFULNESS_QUESTION,
    cacheGroup: 'faithfulness',
    input: `CLAIM: ${claim}\n\n${evidenceBlock}`,
  }));
}

export function buildVerificationItems(impacts: EntityImpact[], report: ImpactReport, options: BuildQuestionsOptions = {}): VerificationItem[] {
  return [...buildCoverageItems(impacts, report), ...buildFaithfulnessItems(impacts, report, options)];
}
