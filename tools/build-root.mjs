import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { stdio: 'inherit', timeout: 60000 });
for (const [name, callable] of [['index', 'run'], ['visualize', 'runVisualizerCli']]) {
  writeFileSync(`dist/${name}.js`, `#!/usr/bin/env node\nconst api = require('./src/${name}.js');\nmodule.exports = api;\nif (require.main === module) Promise.resolve(api.${callable}()).catch(() => { console.error('Graphentra command failed.'); process.exitCode = 1; });\n`, { mode: 0o755 });
}
