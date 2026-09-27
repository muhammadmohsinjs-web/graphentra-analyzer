import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Shared with the analyzer's self-contained test suite.
const fixtureRoot = path.resolve(__dirname, '../../../analyzer/test/fixtures/web-app');

function copy(source: string, target: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copy(from, to); }
    else fs.copyFileSync(from, to);
  }
}

/** Disposable Git copy of fixtures/web-app with one committed baseline. */
export function createWebAppRepository() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-webapp-')));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key];
  const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: dir, env, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  copy(fixtureRoot, dir);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  const edit = (file: string, from: string, to: string) => {
    const full = path.join(dir, file);
    fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(from, to));
  };
  return { dir, git, edit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Changes the payment threshold: amounts equal to the minimum are now declined. */
export function applyPaymentThresholdChange(edit: (file: string, from: string, to: string) => void): void {
  edit('src/server/orderService.ts', 'amount < MIN_ORDER_AMOUNT', 'amount <= MIN_ORDER_AMOUNT');
}
