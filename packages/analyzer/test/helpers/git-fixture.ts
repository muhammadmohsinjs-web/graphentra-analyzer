import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function createRepo(name = 'graphentra-rev-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' });
  const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);
  const commitFile = (relative: string, content: string, message = 'commit') => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
    git(['add', '--', relative]);
    git(['commit', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commitFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
