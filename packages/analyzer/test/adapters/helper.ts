import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { extractApplicationMapWithProvenance } from '../../src/application-map';

/** Extracts the application map for in-memory sources written to a temp directory (no git needed). */
export function mapFor(files: Record<string, string>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphentra-adapter-')));
  try {
    const names = Object.keys(files).sort();
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), files[name]!);
    }
    const sources = names.filter(name => /\.tsx?$/.test(name)).map(name => path.join(dir, name));
    const program = ts.createProgram(sources, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, skipLibCheck: true });
    return extractApplicationMapWithProvenance({
      program, checker: program.getTypeChecker(), symbolToEntity: new Map(), entities: [], relations: [], files: sources,
      toProjectPath: file => path.relative(dir, file).replace(/\\/g, '/'), projectRoot: dir, headSha: 'test',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const NEXT_PACKAGE = JSON.stringify({ dependencies: { next: '14.0.0', react: '18.0.0' } });
