import {
  ANALYZER_VERSION,
  EVIDENCE_ARTIFACT_KIND,
  EVIDENCE_SCHEMA_VERSION,
  type AnalyzeOptions,
  type AnalyzeResult,
  type DiagnosticItem,
  type DeterministicEvidence,
} from './contracts';
import { parseGitDiff } from './change-evidence';
import { buildImpact, findChangedEntities } from './impact';
import { DEFAULT_LIMITATIONS } from './output';
import { captureSourceSnapshot } from './source-snapshot';
import { createRepositoryContext } from './repository';
import { extractTechnicalGraph, isTypeScriptFile } from './technical-graph';
import { assertValidEvidenceEnvelope } from './validator';

export function analyzeRepository(options: AnalyzeOptions): AnalyzeResult {
  const repo = createRepositoryContext(options.target, options.comparison, {
    gitTimeoutMs: options.gitTimeoutMs,
    excludePaths: options.excludePaths,
  });

  const targetPath = repo.projectInsideRepository;
  const headSha = repo.comparison.resolvedHeadSha ?? repo.sourceState.checkoutSha;

  const snapshot = captureSourceSnapshot(repo);
  const extracted = extractTechnicalGraph({
    files: snapshot.files,
    compilerOptions: snapshot.compilerOptions,
    host: snapshot.host,
    projectRoot: repo.projectRoot,
    headSha,
    targetPath,
    excludePaths: options.excludePaths,
  });

  const diagnostics: DiagnosticItem[] = [];
  let gitDiff = snapshot.gitDiff;
  if (repo.comparison.mode === 'working-tree') {
    for (const file of repo.listFiles(true).filter(isTypeScriptFile)) {
      const content = snapshot.readFile(`${repo.projectRoot}/${file}`);
      if (content === undefined) continue;
      const lines = content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (!content) continue;
      const repoFile = repo.projectInsideRepository === '.' ? file : `${repo.projectInsideRepository}/${file}`;
      gitDiff += `\ndiff --git ${JSON.stringify(`a/${repoFile}`)} ${JSON.stringify(`b/${repoFile}`)}\n` +
        `--- /dev/null\n+++ ${JSON.stringify(`b/${repoFile}`)}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map(line => `+${line}`).join('\n') + '\n';
    }
  }
  const changedFiles = parseGitDiff(gitDiff, repo.gitPathToProjectPath)
    .filter(change => repo.includesPath(change.file));
  const supportedChanges = changedFiles.filter(change => isTypeScriptFile(change.file));
  if (changedFiles.some(change => !isTypeScriptFile(change.file))) {
    diagnostics.push({ code: 'OUTSIDE_SUPPORTED_SCOPE', severity: 'warning',
      message: 'Changes outside TypeScript extraction scope were not analyzed for function impact.' });
  }
  const { changedEntities, diagnostics: entityWarnings } = findChangedEntities({
    changedFiles: supportedChanges,
    entities: extracted.entities,
    getBaselineSource: oldFile => repo.getBaselineSource(oldFile, repo.comparison.resolvedBaseSha),
  });
  for (const message of entityWarnings) diagnostics.push({ code: 'AMBIGUOUS_FUNCTION_RANGE', severity: 'warning', message });
  const impacts = changedEntities.map(changed => buildImpact(changed, extracted.reverseAdjacency, extracted.entityById));
  const outcome = extracted.files.length === 0 ? 'no_source_files'
    : changedFiles.length === 0 ? 'no_changes'
    : changedEntities.length === 0 ? 'no_supported_changes' : 'completed';
  if (outcome === 'no_source_files') diagnostics.push({ code: 'NO_SOURCE_FILES', severity: 'info',
    message: 'No current supported TypeScript source files are present; deletion evidence may remain.' });
  if (outcome === 'no_supported_changes') diagnostics.push({ code: 'NO_SUPPORTED_CHANGES', severity: 'warning',
    message: 'Changes did not match supported current function declarations. This is not a no-risk result.' });
  const evidence: DeterministicEvidence = {
    artifactKind: EVIDENCE_ARTIFACT_KIND,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    target: { targetPath },
    comparison: repo.comparison,
    sourceState: { ...repo.sourceState, contentIdentity: snapshot.identity() },
    options: { excludePaths: repo.excludePaths, sourcePolicy: repo.comparison.mode === 'commit'
      ? 'git-tracked' : 'git-tracked-and-nonignored-untracked' },
    outcome, technicalGraph: extracted.technicalGraph, changedFiles, changedEntities, impacts,
    diagnostics, limitations: [...DEFAULT_LIMITATIONS],
  };
  snapshot.verify();
  assertValidEvidenceEnvelope(evidence);
  const summaryMessage = outcome === 'completed' ? `Deterministic impact evidence built for ${impacts.length} changed functions.`
    : outcome === 'no_changes' ? 'No changes were found in the included target scope.'
    : outcome === 'no_source_files' ? 'No TypeScript files were found in the target repository.'
    : 'Changes did not match supported current function declarations.';
  return { outcome, technicalGraph: extracted.technicalGraph, evidence, changedFiles, changedEntities,
    impacts, gitDiff, diagnostics, summaryMessage };
}
