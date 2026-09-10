import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

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
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

interface TypeScriptFile {
  path: string;
  relativePath: string;
  content: string;
  lineCount: number;
}

function collectTypeScriptFiles(dirPath: string): string[] {
  const fileList: string[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        fileList.push(...collectTypeScriptFiles(join(dirPath, entry.name)));
      }
    } else if (entry.isFile() && TS_EXTENSIONS.has(extname(entry.name))) {
      fileList.push(join(dirPath, entry.name));
    }
  }

  return fileList;
}

function readTypeScriptFiles(filePaths: string[]): TypeScriptFile[] {
  return filePaths.map((filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    return {
      path: filePath,
      relativePath: relative(repositoryRoot, filePath),
      content,
      lineCount: content.split('\n').length,
    };
  });
}

console.log('\n========================================');
console.log('🔍  GRAPHENTRA ANALYZER');
console.log('========================================');
console.log(`📁 Target: ${repositoryRoot}`);

const filePaths = collectTypeScriptFiles(repositoryRoot);
const tsFiles = readTypeScriptFiles(filePaths);

console.log(`📘 TypeScript files loaded: ${tsFiles.length}`);
console.log('----------------------------------------');

if (tsFiles.length === 0) {
  console.log('  (no TypeScript files found)');
} else {
  tsFiles.forEach((file, index) => {
    const prefix = String(index + 1).padStart(String(tsFiles.length).length, ' ');
    console.log(`  [${prefix}] ${file.relativePath} (${file.lineCount} lines, ${file.content.length} chars)`);
  });
}

console.log('========================================\n');
