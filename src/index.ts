import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const targetRepository = process.argv.slice(2).find((argument) => !argument.startsWith('--'));

if (!targetRepository) {
  console.error('\n❌ Usage: npm start -- <repository-path>\n');
  process.exit(1);
}

const repositoryRoot = resolve(targetRepository);

if (!existsSync(repositoryRoot)) {
  console.error(`\n❌ Error: Directory not found: ${repositoryRoot}\n`);
  process.exit(1);
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage']);

function collectFiles(dirPath: string): string[] {
  const fileList: string[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        fileList.push(...collectFiles(join(dirPath, entry.name)));
      }
    } else if (entry.isFile()) {
      fileList.push(join(dirPath, entry.name));
    }
  }

  return fileList;
}

console.log('\n========================================');
console.log('🔍  GRAPHENTRA ANALYZER');
console.log('========================================');
console.log(`📁 Target: ${repositoryRoot}`);

const files = collectFiles(repositoryRoot);

console.log(`📄 Files found: ${files.length}`);
console.log('----------------------------------------');

if (files.length === 0) {
  console.log('  (no files found)');
} else {
  files.forEach((file, index) => {
    const rel = relative(repositoryRoot, file);
    const prefix = String(index + 1).padStart(String(files.length).length, ' ');
    console.log(`  [${prefix}] ${rel}`);
  });
}

console.log('========================================\n');
