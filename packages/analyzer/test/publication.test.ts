import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { writeEvidenceFile } from '../src/output';
const evidence = require('./fixtures/evidence/valid.json');
test('publication validates before writing and cleans its temporary file after rename failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-publish-'));
  try {
    const destination = path.join(directory, 'evidence');
    writeEvidenceFile(destination, evidence);
    const before = fs.readFileSync(destination);
    assert.throws(() => writeEvidenceFile(destination, { invalid: true }));
    assert.deepEqual(fs.readFileSync(destination), before);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    const collision = path.join(directory, 'directory');
    fs.mkdirSync(collision);
    assert.throws(() => writeEvidenceFile(collision, evidence));
    assert.deepEqual(fs.readdirSync(directory).sort(), ['directory', 'evidence']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
