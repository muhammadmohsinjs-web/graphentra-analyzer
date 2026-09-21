#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

console.log('🔍 Verifying workspace boundaries and dependency rules...');

let errors = [];

function checkFileForForbiddenPatterns(filePath, forbiddenPatterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  for (const { pattern, message } of forbiddenPatterns) {
    if (pattern.test(content)) {
      errors.push(`${filePath}: ${message}`);
    }
  }
}

// 1. Dependency checks in package.json files
const analyzerPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'packages/analyzer/package.json'), 'utf8'));
const reportingPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'packages/reporting/package.json'), 'utf8'));
const visualizerPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/visualizer/package.json'), 'utf8'));
const ciRunnerPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/ci-runner/package.json'), 'utf8'));

// Analyzer rules
const analyzerDeps = Object.keys(analyzerPkg.dependencies || {});
const forbiddenAnalyzerDeps = ['openai', 'dotenv', 'zod', '@graphentra/reporting', '@graphentra/visualizer', '@graphentra/ci-runner'];
for (const dep of forbiddenAnalyzerDeps) {
  if (analyzerDeps.includes(dep)) {
    errors.push(`@graphentra/analyzer must not depend on "${dep}".`);
  }
}
if (!analyzerDeps.includes('typescript')) {
  errors.push('@graphentra/analyzer must depend on "typescript".');
}

// Visualizer rules
const visualizerDeps = Object.keys(visualizerPkg.dependencies || {});
const forbiddenVisualizerDeps = ['typescript', 'openai', '@graphentra/analyzer', '@graphentra/reporting', '@graphentra/ci-runner'];
for (const dep of forbiddenVisualizerDeps) {
  if (visualizerDeps.includes(dep)) {
    errors.push(`@graphentra/visualizer must not depend on "${dep}".`);
  }
}

// Reporting rules
const reportingDeps = Object.keys(reportingPkg.dependencies || {});
if (reportingDeps.includes('@graphentra/visualizer') || reportingDeps.includes('@graphentra/ci-runner')) {
  errors.push('@graphentra/reporting must not depend on visualizer or ci-runner.');
}

// CI Runner rules
const ciRunnerDeps = Object.keys(ciRunnerPkg.dependencies || {});
if (ciRunnerDeps.includes('@graphentra/visualizer') || ciRunnerDeps.includes('@graphentra/reporting')) {
  errors.push('@graphentra/ci-runner must not depend on visualizer or reporting.');
}

// 2. Check for forbidden relative imports reaching into sibling packages src/ or dist/
function scanDirectory(dir, forbiddenPatterns) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      scanDirectory(full, forbiddenPatterns);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      checkFileForForbiddenPatterns(full, forbiddenPatterns);
    }
  }
}

const forbiddenSiblingImports = [
  {
    pattern: /from\s+['"][^'"]*packages\/(analyzer|reporting)\/(src|dist)/,
    message: 'Forbidden direct import into sibling package src/ or dist/. Resolve declared package exports instead.',
  },
  {
    pattern: /from\s+['"][^'"]*apps\/(visualizer|ci-runner)\/(src|dist)/,
    message: 'Forbidden direct import into sibling app src/ or dist/. Resolve declared package exports instead.',
  },
  {
    pattern: /from\s+['"]\.\.\/+(packages|apps)\//,
    message: 'Forbidden relative import reaching across workspace boundaries.',
  },
];

scanDirectory(path.join(rootDir, 'packages'), forbiddenSiblingImports);
scanDirectory(path.join(rootDir, 'apps'), forbiddenSiblingImports);

// 3. Analyzer source isolation check
const forbiddenAnalyzerImports = [
  {
    pattern: /from\s+['"](openai|dotenv|zod)['"]/,
    message: 'Analyzer source must not import openai, dotenv, or zod.',
  },
  {
    pattern: /from\s+['"]@graphentra\//,
    message: 'Analyzer source must not import other @graphentra packages.',
  },
];
scanDirectory(path.join(rootDir, 'packages/analyzer/src'), forbiddenAnalyzerImports);

// 4. Check tsconfig paths in packages
for (const tsconfigPath of [
  'packages/analyzer/tsconfig.json',
  'packages/reporting/tsconfig.json',
  'apps/visualizer/tsconfig.json',
  'apps/ci-runner/tsconfig.json',
]) {
  const fullPath = path.join(rootDir, tsconfigPath);
  if (fs.existsSync(fullPath)) {
    const tsconfig = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (tsconfig.compilerOptions?.paths) {
      for (const [alias, targets] of Object.entries(tsconfig.compilerOptions.paths)) {
        for (const target of targets) {
          if (target.includes('../')) {
            errors.push(`${tsconfigPath}: Forbidden path alias "${alias}" pointing to sibling directory "${target}".`);
          }
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error('\n❌ Boundary check violations found:');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log('✅ All boundary rules and dependency constraints verified successfully.\n');
