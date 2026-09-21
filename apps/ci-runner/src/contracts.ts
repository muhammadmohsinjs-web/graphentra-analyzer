import type { DeterministicEvidence } from '@graphentra/analyzer';

export const CI_RUNNER_VERSION = '0.1.0';

export interface RepositoryIdentity {
  name: string;
  remoteUrl?: string;
}

export interface PullRequestMetadata {
  number: number;
  baseBranch?: string;
  headBranch?: string;
}

export type ComparisonPolicy = 'merge-base-to-head' | 'base-to-head' | 'working-tree';

export interface SubmissionPayload {
  repository: RepositoryIdentity;
  pullRequest?: PullRequestMetadata;
  comparisonPolicy: ComparisonPolicy;
  evidence: DeterministicEvidence;
}

export interface SubmissionResult {
  id: string;
  status: 'queued' | 'accepted';
}
