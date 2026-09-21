import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
test('library import performs no writes, subprocesses, logging, exits, or network calls', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-import-'));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|NODE_PATH|BASE_SHA|HEAD_SHA/.test(key)) delete env[key];
    const script = `
      const fail = () => { throw new Error('Import side effect'); };
      for (const name of ['writeFileSync','mkdirSync','renameSync','unlinkSync','appendFileSync','rmSync']) require('node:fs')[name] = fail;
      for (const name of ['execSync','execFileSync','spawnSync','exec','execFile','spawn','fork']) require('node:child_process')[name] = fail;
      for (const name of ['http','https','net','tls','dns']) {
        const mod = require('node:' + name);
        for (const key of ['request','get','connect','createConnection','lookup','resolve']) if (typeof mod[key] === 'function') mod[key] = fail;
      }
      global.fetch = fail;
      console.log = console.warn = console.error = fail;
      process.exit = fail;
      process.argv = ['node','ignored','--invalid'];
      require(${JSON.stringify(path.resolve(__dirname, '../dist/index.js'))});
    `;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
