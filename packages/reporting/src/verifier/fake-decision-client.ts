import { EMPTY_USAGE, type DecideOptions, type DecisionClient, type DecisionQuestion, type DecisionResult } from './decision-client';

/** What the fake returns for one question: a probability, `refusal`, `error`, or `omit` (leave the answer out). */
export type FakeReply = number | 'refusal' | 'error' | 'omit';

export interface FakeDecisionCall {
  input: string;
  questions: DecisionQuestion[];
  options: DecideOptions;
}

export interface FakeDecisionClient extends DecisionClient {
  readonly calls: FakeDecisionCall[];
}

/** Offline stand-in for the OpenAI client. All reporting tests use this; none touch the network. */
export function createFakeDecisionClient(reply: (question: DecisionQuestion, input: string) => FakeReply = () => 0.95): FakeDecisionClient {
  const calls: FakeDecisionCall[] = [];
  return {
    calls,
    async decide(input, questions, options = {}): Promise<DecisionResult> {
      calls.push({ input, questions, options });
      const answers: DecisionResult['answers'] = [];
      for (const question of questions) {
        const value = reply(question, input);
        if (value === 'omit') continue;
        if (value === 'refusal') answers.push({ id: question.id, outcome: 'refusal' });
        else if (value === 'error') answers.push({ id: question.id, outcome: 'error', message: 'fake error' });
        else answers.push({ id: question.id, outcome: 'answer', probability: value });
      }
      return { answers, usage: EMPTY_USAGE, model: 'fake' };
    },
  };
}
