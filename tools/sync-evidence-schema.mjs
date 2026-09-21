import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve('@graphentra/analyzer/evidence.schema.json'));
const directory = new URL('../apps/visualizer/schema/', import.meta.url);
const destination = new URL('evidence.schema.json', directory);
if (process.argv.includes('--check')) {
  if (!source.equals(readFileSync(destination))) throw new Error('Visualizer evidence schema is stale; run npm run sync:evidence-schema.');
} else {
  mkdirSync(directory, { recursive: true });
  writeFileSync(destination, source);
}
