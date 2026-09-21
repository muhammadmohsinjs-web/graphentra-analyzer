import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ComparisonOptions,
  type DeterministicEvidence,
  analyzeRepository,
  assertValidEvidenceEnvelope,
  writeJsonArtifact,
} from '@graphentra/analyzer';
import type {
  ComparisonPolicy,
  PullRequestMetadata,
  RepositoryIdentity,
  SubmissionResult,
} from './contracts';
import { submitEvidence, type SubmitEvidenceOptions } from './submit';

export interface AnalyzeAndSubmitOptions {
  target: string;
  comparison: ComparisonOptions;
  repository: RepositoryIdentity;
  pullRequest?: PullRequestMetadata;
  comparisonPolicy?: ComparisonPolicy;
  backendUrl: string;
  token: string;
  outputDir?: string;
  outputEvidencePath?: string;
  allowHttpForTesting?: boolean;
}

export interface AnalyzeAndSubmitResult {
  evidence: DeterministicEvidence;
  evidencePath: string;
  submission: SubmissionResult;
}

export async function analyzeAndSubmit(
  options: AnalyzeAndSubmitOptions,
): Promise<AnalyzeAndSubmitResult> {
  const {
    target,
    comparison,
    repository,
    pullRequest,
    comparisonPolicy = comparison.mode === 'working-tree' ? 'working-tree' : 'merge-base-to-head',
    backendUrl,
    token,
    outputDir = path.join(path.resolve(target), '.graphentra'),
    outputEvidencePath,
    allowHttpForTesting,
  } = options;

  // 1. Run deterministic analyzer
  const analysisResult = analyzeRepository({
    target,
    comparison,
  });

  // 2. Persist evidence to disk immediately
  const destDir = outputEvidencePath ? path.dirname(path.resolve(outputEvidencePath)) : outputDir;
  const fileName = outputEvidencePath ? path.basename(path.resolve(outputEvidencePath)) : 'evidence.json';

  const savedEvidencePath = writeJsonArtifact(destDir, fileName, analysisResult.evidence);

  // 3. Submit evidence
  const submission = await submitEvidence({
    backendUrl,
    token,
    payload: {
      repository,
      pullRequest,
      comparisonPolicy,
      evidence: analysisResult.evidence,
    },
    allowHttpForTesting,
  });

  return {
    evidence: analysisResult.evidence,
    evidencePath: savedEvidencePath,
    submission,
  };
}

export async function resubmitEvidenceFile(options: {
  evidencePath: string;
  repository: RepositoryIdentity;
  pullRequest?: PullRequestMetadata;
  comparisonPolicy?: ComparisonPolicy;
  backendUrl: string;
  token: string;
  allowHttpForTesting?: boolean;
}): Promise<SubmissionResult> {
  const {
    evidencePath,
    repository,
    pullRequest,
    comparisonPolicy = 'merge-base-to-head',
    backendUrl,
    token,
    allowHttpForTesting,
  } = options;

  if (!fs.existsSync(evidencePath)) {
    throw new Error(`Evidence file not found: ${evidencePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assertValidEvidenceEnvelope(raw);

  return submitEvidence({
    backendUrl,
    token,
    payload: {
      repository,
      pullRequest,
      comparisonPolicy,
      evidence: raw,
    },
    allowHttpForTesting,
  });
}
