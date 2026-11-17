import type { EntityImpact } from '@graphentra/analyzer';
import { addUsage, EMPTY_USAGE, type DecisionAnswer, type DecisionClient, type DecisionUsage } from './decision-client';
import { buildVerificationItems, type BuildQuestionsOptions } from './questions';
import { buildVerificationBlock, DEFAULT_THRESHOLD, type VerificationBlock } from './verdict';
import type { ImpactReport } from '../llm-client';

export interface VerifyReportInput extends BuildQuestionsOptions {
  client: DecisionClient;
  impacts: EntityImpact[];
  report: ImpactReport;
  threshold?: number;
  /** Used to build the prompt cache key. */
  cacheKey?: string;
  /** Parallel calls. Each item has its own input, so they cannot share one request. */
  concurrency?: number;
}

export interface VerifyReportResult {
  verification: VerificationBlock;
  usage: DecisionUsage;
}

/** Runs U1 + U3 for a finished report. Never throws for provider problems: they become "not covered" entries. */
export async function verifyReport(input: VerifyReportInput): Promise<VerifyReportResult> {
  const items = buildVerificationItems(input.impacts, input.report, { priorState: input.priorState });
  const answers = new Map<string, DecisionAnswer>();
  let usage = EMPTY_USAGE;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      const result = await input.client.decide(item.input, [{ id: item.id, instructions: item.instructions }], {
        cacheKey: `graphentra-verify-${input.cacheKey ?? 'run'}-${item.cacheGroup}`,
      });
      usage = addUsage(usage, result.usage);
      for (const answer of result.answers) answers.set(answer.id, answer);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 4, items.length)) }, worker));
  return { verification: buildVerificationBlock(items, answers, input.threshold ?? DEFAULT_THRESHOLD), usage };
}
