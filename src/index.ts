import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

// Path passed from GitHub Actions:
//
// npm run analyze -- ../demo-application
//
const targetRepository = process.argv[2];

if (!targetRepository) {
  console.error('❌ Repository path is required');
  console.error('Usage: npm run analyze -- <repository-path>');
  process.exit(1);
}

const repositoryRoot = resolve(targetRepository);

if (!existsSync(repositoryRoot)) {
  console.error(`❌ Repository not found: ${repositoryRoot}`);
  process.exit(1);
}

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function getChangedFiles(): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf-8',
    });

    return output
      .split('\n')
      .map(file => file.trim())
      .filter(Boolean);
  } catch (error) {
    console.error('❌ Could not read Git changes');
    console.error(error);
    process.exit(1);
  }
}

function getChangedTypeScriptFiles(files: string[]): string[] {
  return files.filter(file => TYPESCRIPT_EXTENSIONS.has(extname(file)));
}

// -------------------------------------
// Run Analyzer
// -------------------------------------

console.log('\n========================================');
console.log('🔍 GRAPHENTRA ANALYZER');
console.log('========================================');

console.log(`📁 Repository: ${repositoryRoot}`);

const changedFiles = getChangedFiles();

console.log('\n📄 Changed files:');

if (changedFiles.length === 0) {
  console.log('No changed files found.');
} else {
  for (const file of changedFiles) {
    console.log(`- ${file}`);
  }
}

const changedTypeScriptFiles = getChangedTypeScriptFiles(changedFiles);

console.log('\n📘 Changed TypeScript files:');

if (changedTypeScriptFiles.length === 0) {
  console.log('No TypeScript files changed.');
} else {
  for (const file of changedTypeScriptFiles) {
    console.log(`- ${file}`);
  }
}

console.log('\n========================================\n');
