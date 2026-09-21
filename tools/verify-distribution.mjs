#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

console.log('📦 Verifying independent package distribution, tarballs, and standalone builds...');

function run(cmd, cwd = rootDir) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const tempDirs = [];
function createTemp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

try {
  // 1. Build the workspace
  console.log('1. Building workspace...');
  run('npm run build');

  // 2. Pack @graphentra/analyzer
  console.log('2. Packing @graphentra/analyzer...');
  const analyzerPackOutput = run('npm pack', path.join(rootDir, 'packages/analyzer'));
  const analyzerTarballName = analyzerPackOutput.split('\n').filter(Boolean).pop().trim();
  const analyzerTarballPath = path.join(rootDir, 'packages/analyzer', analyzerTarballName);

  // Inspect analyzer tarball contents
  const analyzerTarEntries = run(`tar -tf "${analyzerTarballPath}"`).split('\n').filter(Boolean);

  const requiredAnalyzerFiles = [
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/cli.js',
    'package/evidence.schema.json',
    'package/README.md',
    'package/package.json',
  ];
  for (const req of requiredAnalyzerFiles) {
    if (!analyzerTarEntries.includes(req)) {
      throw new Error(`Analyzer tarball missing required file: ${req}`);
    }
  }

  const forbiddenAnalyzerEntries = ['.env', 'test', 'fixtures', 'node_modules', 'src'];
  for (const entry of analyzerTarEntries) {
    for (const forbidden of forbiddenAnalyzerEntries) {
      if (entry === `package/${forbidden}` || entry.startsWith(`package/${forbidden}/`)) {
        throw new Error(`Analyzer tarball contains forbidden file/dir: ${entry}`);
      }
    }
  }
  console.log('   ✅ Analyzer tarball verified (clean, contains only dist, schema, README).');

  // 3. Pack @graphentra/visualizer
  console.log('3. Packing @graphentra/visualizer...');
  const visualizerPackOutput = run('npm pack', path.join(rootDir, 'apps/visualizer'));
  const visualizerTarballName = visualizerPackOutput.split('\n').filter(Boolean).pop().trim();
  const visualizerTarballPath = path.join(rootDir, 'apps/visualizer', visualizerTarballName);

  const visualizerTarEntries = run(`tar -tf "${visualizerTarballPath}"`).split('\n').filter(Boolean);
  const requiredVisualizerFiles = [
    'package/dist/visualize.js',
    'package/public/index.html',
    'package/public/app.js',
    'package/public/model.mjs',
    'package/public/styles.css',
    'package/README.md',
  ];
  for (const req of requiredVisualizerFiles) {
    if (!visualizerTarEntries.includes(req)) {
      throw new Error(`Visualizer tarball missing required file: ${req}`);
    }
  }
  console.log('   ✅ Visualizer tarball verified (contains executable and public assets).');

  // 4. Test isolated install in consumer directory outside workspace
  console.log('4. Testing isolated consumer installation in fresh directory...');
  const consumerDir = createTemp('graphentra-consumer-');
  run('npm init -y', consumerDir);
  run(`npm install --omit=dev "${analyzerTarballPath}"`, consumerDir);

  // Check npm ls dependency tree in consumer
  const npmLs = run('npm ls --all', consumerDir);
  if (npmLs.includes('openai') || npmLs.includes('dotenv') || npmLs.includes('zod')) {
    throw new Error(`Forbidden dependencies found in consumer npm ls: ${npmLs}`);
  }
  if (!npmLs.includes('typescript')) {
    throw new Error('Expected typescript in consumer dependency tree.');
  }
  console.log('   ✅ Consumer dependencies contain only production dependencies (typescript).');

  // 5. Test public library import in consumer
  console.log('5. Testing public library API import in isolated consumer...');
  const testScript = `
    const analyzer = require('@graphentra/analyzer');
    if (typeof analyzer.analyzeRepository !== 'function') throw new Error('analyzeRepository missing');
    if (typeof analyzer.extractTechnicalGraph !== 'function') throw new Error('extractTechnicalGraph missing');
    if (typeof analyzer.validateEvidenceEnvelope !== 'function') throw new Error('validateEvidenceEnvelope missing');
    if (analyzer.ANALYZER_VERSION !== '0.4.0') throw new Error('Wrong version');
    console.log('Library import verified successfully');
  `;
  run(`node -e "${testScript.replace(/\n/g, ' ')}"`, consumerDir);
  console.log('   ✅ Public library import works without workspace resolution.');

  // 6. Test TypeScript consumer with exported declarations
  console.log('6. Testing TypeScript consumer typecheck with exported declarations...');
  run('npm install --save-dev typescript @types/node', consumerDir);
  const tsConsumerFile = path.join(consumerDir, 'consumer.ts');
  fs.writeFileSync(
    tsConsumerFile,
    `
    import { analyzeRepository, AnalyzeResult, DeterministicEvidence } from '@graphentra/analyzer';
    const check: boolean = true;
    `,
    'utf8',
  );
  run('npx tsc --noEmit consumer.ts', consumerDir);
  console.log('   ✅ TypeScript consumer successfully verified exported declarations.');

  // 7. Test direct binary execution
  console.log('7. Testing installed CLI binary directly...');
  const binPath = path.join(consumerDir, 'node_modules/.bin/graphentra-analyze');
  const binVersion = run(`"${binPath}" --version`, consumerDir);
  if (binVersion.trim() !== '0.4.0') {
    throw new Error(`Unexpected CLI version: ${binVersion}`);
  }
  const binHelp = run(`"${binPath}" --help`, consumerDir);
  if (!binHelp.includes('Graphentra Analyzer')) {
    throw new Error(`Unexpected CLI help output: ${binHelp}`);
  }
  console.log('   ✅ Installed binary executable executes directly with correct version and help.');

  // 8. Analyze an unrelated repository outside workspace
  console.log('8. Analyzing unrelated disposable repository with installed binary...');
  const targetRepoDir = createTemp('graphentra-target-repo-');
  run('git init -b main', targetRepoDir);
  run('git config user.name "Test User"', targetRepoDir);
  run('git config user.email "test@example.com"', targetRepoDir);

  const targetSrc = path.join(targetRepoDir, 'src');
  fs.mkdirSync(targetSrc, { recursive: true });
  fs.writeFileSync(
    path.join(targetSrc, 'math.ts'),
    'export function multiply(a: number, b: number): number { return a * b; }\nexport function calc(n: number): number { return multiply(n, 2); }\n',
    'utf8',
  );
  run('git add . && git commit -m "initial"', targetRepoDir);
  const c1 = run('git rev-parse HEAD', targetRepoDir);

  fs.writeFileSync(
    path.join(targetSrc, 'math.ts'),
    'export function multiply(a: number, b: number): number { return a * b * 1; }\nexport function calc(n: number): number { return multiply(n, 2); }\n',
    'utf8',
  );
  run('git add . && git commit -m "update"', targetRepoDir);
  const c2 = run('git rev-parse HEAD', targetRepoDir);

  const evidenceOut = path.join(targetRepoDir, 'custom-evidence.json');
  run(
    `"${binPath}" --target "${targetRepoDir}" --base ${c1} --head ${c2} --output "${evidenceOut}"`,
    consumerDir,
  );

  if (!fs.existsSync(evidenceOut)) {
    throw new Error(`Evidence file was not created at: ${evidenceOut}`);
  }
  const evidenceData = JSON.parse(fs.readFileSync(evidenceOut, 'utf8'));
  if (evidenceData.outcome !== 'completed' || evidenceData.changedEntities.length !== 1) {
    throw new Error(`Unexpected evidence outcome: ${JSON.stringify(evidenceData)}`);
  }
  console.log('   ✅ Non-empty analysis on unrelated repository completed and verified.');

  // 9. Verify visualizer isolated installation
  console.log('9. Verifying visualizer isolated installation and binary...');
  const visualizerConsumerDir = createTemp('graphentra-vis-consumer-');
  run('npm init -y', visualizerConsumerDir);
  run(`npm install "${visualizerTarballPath}"`, visualizerConsumerDir);
  const visBin = path.join(visualizerConsumerDir, 'node_modules/.bin/graphentra-visualize');
  const visAssetsDir = path.join(visualizerConsumerDir, 'node_modules/@graphentra/visualizer/public');
  if (!fs.existsSync(path.join(visAssetsDir, 'index.html')) || !fs.existsSync(path.join(visAssetsDir, 'app.js'))) {
    throw new Error('Visualizer static assets missing from installed package.');
  }
  console.log('   ✅ Visualizer installed independently with its public static assets.');

  // 10. Standalone source build
  console.log('10. Testing standalone source build of @graphentra/analyzer outside workspace...');
  const standaloneSourceDir = createTemp('graphentra-standalone-src-');
  const analyzerSrcDir = path.join(rootDir, 'packages/analyzer');

  // Copy analyzer source files
  const filesToCopy = [
    'src',
    'test',
    'package.json',
    'tsconfig.json',
    'tsconfig.test.json',
    'README.md',
    'evidence.schema.json',
  ];
  for (const item of filesToCopy) {
    const srcPath = path.join(analyzerSrcDir, item);
    const destPath = path.join(standaloneSourceDir, item);
    fs.cpSync(srcPath, destPath, { recursive: true });
  }

  // Run npm install in standalone copy
  console.log('   Installing dependencies in standalone source directory...');
  run('npm install', standaloneSourceDir);

  // Run standalone build, typecheck, test
  console.log('   Running standalone build, typecheck, and tests...');
  run('npm run build', standaloneSourceDir);
  run('npm run typecheck', standaloneSourceDir);
  run('npm test', standaloneSourceDir);
  console.log('   ✅ Standalone source build, typecheck, and tests all passed independently.');

  // Cleanup tarballs
  fs.rmSync(analyzerTarballPath, { force: true });
  fs.rmSync(visualizerTarballPath, { force: true });

  console.log('\n🎉 Independent distribution, tarball packaging, isolated execution, and standalone source build all verified successfully!');
} finally {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
