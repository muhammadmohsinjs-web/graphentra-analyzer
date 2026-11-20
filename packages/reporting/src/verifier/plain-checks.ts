import type { EntityImpact } from '@graphentra/analyzer';
import {
  generateStructured,
  logLLMTrace,
  NOT_COVERED_LINES,
  validateImpactReportSemantics,
  type ImpactReport,
  type LLMClientOptions,
  type NotCoveredCheck,
  type NotCoveredItem,
} from '../llm-client';
import { CODE_CAP, EVIDENCE_CAP, renderChange, renderReport } from './questions';

// Phase V (ADR-0011), V-13e. After the verifier lists the gaps, one LLM call rewrites them as checks a manual tester can run
// (QA found code names useless). It sees the finished report, so it can merge related gaps and avoid repeating a check.
// Recall first: every gap also stays listed by its code name for a developer (V-13f), so a check never hides one.

export const PLAIN_CHECKS_SYSTEM = [
  'You help a manual QA tester. A QA report was written for a code change, and an automatic check found changed code that the report does not test.',
  'Turn those GAPS into short checks the tester can run against the running application or library.',
  'Rules for each check:',
  '- Start with Verify, Check, Confirm, Validate, Test or Ensure.',
  '- Say what to do and what result to expect, in plain words a tester understands. Describe behaviour a user or caller can observe.',
  '- No file names, no function, class or variable names, no code, no Markdown, one line.',
  '- Use only what the BEFORE and AFTER code shows. Do not invent behaviour, settings or values that are not in the code.',
  '- Do not repeat a check the QA REPORT already has; check what it misses.',
  '- If the gap REMOVES code (AFTER is empty or drops behaviour), never ask to verify that the removed behaviour still works. Check that the replacement works, or that the old behaviour is gone, as the code shows.',
  'A check names a gap in `changes` only if carrying out the check exercises the behaviour that changed in that gap. Never add a gap to a check just to place it; write another check instead, within the limit.',
  'Merge gaps into one check only when that one check really tests each of them. Every gap key must be in exactly one place: the `changes` of a check, or `untestable`.',
  'Put a gap in `untestable` only when its change has no effect a tester or a caller could observe (for example only types, comments or internal wiring with the same behaviour). Adding, removing or renaming something a library exports, or changing a component property that changes what is rendered, IS observable.',
].join('\n');

export interface PlainChecksResult {
  checks: NotCoveredCheck[];
  /** Gap entities the model said have no observable effect. They stay in the developer list. */
  untestable: string[];
  /** Gap entities left to the developer list because no valid check named them (invalid text, over the limit, or a failed call). */
  fallback: string[];
  usage: { promptTokens: number; completionTokens: number; calls: number };
  durationMs: number;
  error?: string;
}

/** E7 (changed 2026-11-20): at most this many QA lines for the gaps in any report. */
export const MAX_PLAIN_CHECKS = 7;

/** At most one check per gap, no more lines than the grouped code list would take (V-13d), and never more than E7 allows. */
export function plainCheckLimit(items: NotCoveredItem[]): number {
  return Math.min(items.length, MAX_PLAIN_CHECKS, Math.max(NOT_COVERED_LINES, new Set(items.map(item => item.file)).size));
}

export function buildPlainChecksInput(report: ImpactReport, items: NotCoveredItem[], impacts: EntityImpact[]): { user: string; keys: Map<string, string> } {
  const byId = new Map(impacts.map(impact => [impact.changedEntity.id, impact]));
  const keys = new Map(items.map((item, index) => [`G${index + 1}`, item.entity]));
  // Share the evidence budget across the gaps so the last ones are never cut away.
  const codeCap = Math.max(400, Math.min(CODE_CAP, Math.floor(EVIDENCE_CAP / (2 * Math.max(1, items.length)))));
  const gaps = [...keys].map(([key, entity]) => {
    const impact = byId.get(entity);
    return impact ? renderChange(impact, `GAP ${key}:`, codeCap) : `GAP ${key}: ${entity} (no code available)`;
  });
  return {
    keys,
    user: `${renderReport(report)}\n\nGAPS (changed code the report does not test)\n\n${gaps.join('\n\n')}\n\nWrite at most ${plainCheckLimit(items)} checks. Gap keys: ${[...keys.keys()].join(', ')}.`,
  };
}

const jsonSchema = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } },
        required: ['text', 'changes'],
        additionalProperties: false,
      },
    },
    untestable: { type: 'array', items: { type: 'string' } },
  },
  required: ['checks', 'untestable'],
  additionalProperties: false,
};

interface Answer { checks: Array<{ text: string; changes: string[] }>; untestable: string[] }

const parse = (value: unknown): Answer => {
  const answer = value as Answer;
  if (!Array.isArray(answer?.checks) || !Array.isArray(answer?.untestable)) throw new Error('checks and untestable are required');
  return { checks: answer.checks.map(check => ({ text: String(check.text ?? '').trim(), changes: (check.changes ?? []).map(String) })), untestable: answer.untestable.map(String) };
};

/** Per-check text problems, with the report rules for QA checks (plain text, starts with a verb, no code names). */
export function checkTextErrors(text: string): string[] {
  return validateImpactReportSemantics({ summary: 'Done.', keyChanges: ['Done.'], qaChecks: [text], uncertainty: [] }).map(error => error.replace(/^qaChecks\[0\] /, ''));
}

export function validatePlainChecks(answer: Answer, keys: Map<string, string>, limit: number): string[] {
  const errors: string[] = [];
  if (answer.checks.length > limit) errors.push(`Write at most ${limit} checks; merge checks that test the same behaviour.`);
  answer.checks.forEach((check, index) => {
    for (const error of checkTextErrors(check.text)) errors.push(`checks[${index}].text ${error}`);
    if (!check.changes.length) errors.push(`checks[${index}].changes must name at least one gap key.`);
  });
  const placed = [...answer.checks.flatMap(check => check.changes), ...answer.untestable];
  const unknown = [...new Set(placed.filter(key => !keys.has(key)))];
  if (unknown.length) errors.push(`Unknown gap keys: ${unknown.join(', ')}. Use only ${[...keys.keys()].join(', ')}.`);
  const missing = [...keys.keys()].filter(key => !placed.includes(key));
  if (missing.length) errors.push(`Gap keys ${missing.join(', ')} are in no check and not in untestable. Add each to the check that tests it, write a check for it, or mark it untestable.`);
  return errors;
}

/** One call (plus at most one correction). Never throws: on failure every gap stays in the developer list. */
export async function writePlainChecks(report: ImpactReport, items: NotCoveredItem[], impacts: EntityImpact[], options?: LLMClientOptions): Promise<PlainChecksResult> {
  const startedAt = Date.now();
  const empty = { promptTokens: 0, completionTokens: 0, calls: 0 };
  if (!items.length) return { checks: [], untestable: [], fallback: [], usage: empty, durationMs: 0 };
  const { user, keys } = buildPlainChecksInput(report, items, impacts);
  const limit = plainCheckLimit(items);
  try {
    const { value, usage } = await generateStructured<Answer>({
      task: 'verifier.plain_checks', system: PLAIN_CHECKS_SYSTEM, user, schemaName: 'graphentra_plain_checks', jsonSchema, parse,
      validate: answer => validatePlainChecks(answer, keys, limit), acceptRemainingErrors: true, reasoningEffort: 'low', options,
    });
    // Keep only checks that pass the rules, within the limit; whatever they do not name stays listed by code name.
    const checks = value.checks
      .filter(check => !checkTextErrors(check.text).length)
      .map(check => ({ text: check.text, entities: [...new Set(check.changes.filter(key => keys.has(key)).map(key => keys.get(key)!))] }))
      .filter(check => check.entities.length)
      .slice(0, limit);
    const named = new Set(checks.flatMap(check => check.entities));
    const untestable = [...new Set(value.untestable.filter(key => keys.has(key)).map(key => keys.get(key)!))].filter(entity => !named.has(entity));
    const fallback = items.map(item => item.entity).filter(entity => !named.has(entity) && !untestable.includes(entity));
    const result = { checks, untestable, fallback, usage, durationMs: Date.now() - startedAt };
    logLLMTrace('verifier.plain_checks', { gaps: items.length, checks: checks.length, untestable: untestable.length, fallback: fallback.length, usage, durationMs: result.durationMs });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLLMTrace('verifier.plain_checks_failed', { gaps: items.length, error: message });
    return { checks: [], untestable: [], fallback: items.map(item => item.entity), usage: empty, durationMs: Date.now() - startedAt, error: message };
  }
}
