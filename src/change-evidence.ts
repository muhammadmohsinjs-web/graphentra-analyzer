import * as ts from 'typescript';

export interface EntityChange {
  file: string;
  // New-file coordinates; pure deletions use an anchor within the surviving function.
  changedLines: number[];
  addedCode: string[];
  removedCode: string[];
  diff: string;
}

interface DiffLine {
  kind: ' ' | '+' | '-';
  code: string;
  oldLine: number;
  newLine: number;
}

export interface ChangedFile extends EntityChange {
  oldFile?: string;
  hunks: Array<{ lines: DiffLine[] }>;
}

export interface FunctionRange {
  name: string;
  startLine: number;
  endLine: number;
}

export function parseGitDiff(diff: string, normalizePath: (file: string) => string = file => file): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let oldFile: string | undefined;
  let headers: string[] = [];
  let hunk: ChangedFile['hunks'][number] | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      oldFile = undefined;
      hunk = undefined;
      headers = [line];
      continue;
    }

    if (!current) {
      headers.push(line);
      if (line.startsWith('--- ')) {
        const file = line.slice(4);
        oldFile = file === '/dev/null' ? undefined : normalizePath(file.startsWith('"') ? JSON.parse(file).slice(2) : file.slice(2));
      }
      if (line.startsWith('+++ ')) {
        const file = line.slice(4);
        const newFile = file === '/dev/null' ? oldFile : normalizePath(file.startsWith('"') ? JSON.parse(file).slice(2) : file.slice(2));
        if (newFile) {
          current = { file: newFile, oldFile, changedLines: [], addedCode: [], removedCode: [], diff: headers.join('\n'), hunks: [] };
          files.push(current);
        }
      }
      continue;
    }

    current.diff += `\n${line}`;
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      oldLine = Number(match[1]) + (match[2] === '0' ? 1 : 0);
      newLine = Number(match[3]) + (match[4] === '0' ? 1 : 0);
      hunk = { lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk || ![' ', '+', '-'].includes(line[0] ?? '')) continue;

    const kind = line[0] as DiffLine['kind'];
    const code = line.slice(1);
    hunk.lines.push({ kind, code, oldLine, newLine });
    if (kind !== ' ') current.changedLines.push(Math.max(newLine, 1));
    if (kind === '+') current.addedCode.push(code);
    if (kind === '-') current.removedCode.push(code);
    if (kind !== '+') oldLine += 1;
    if (kind !== '-') newLine += 1;
  }

  for (const file of files) {
    file.changedLines = [...new Set(file.changedLines)].sort((a, b) => a - b);
    file.diff = file.diff.trimEnd();
  }
  return files;
}

// Before-version ranges are used only to attribute removals, not to build new graph relationships.
export function getFunctionRanges(file: string, source: string): FunctionRange[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const ranges: FunctionRange[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      ranges.push({
        name: node.name.text,
        startLine: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        endLine: ast.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return ranges;
}

export function extractEntityChange(
  file: ChangedFile,
  entity: FunctionRange,
  previousEntity: FunctionRange | undefined,
): EntityChange | undefined {
  const within = (line: number, range: FunctionRange | undefined) => !!range && line >= range.startLine && line <= range.endLine;
  const addedCode: string[] = [];
  const removedCode: string[] = [];
  const changedLines = new Set<number>();
  const patches: string[] = [];

  for (const hunk of file.hunks) {
    let segment: DiffLine[] = [];
    const flush = () => {
      if (segment.some(line => line.kind !== ' ')) {
        const oldCount = segment.filter(line => line.kind !== '+').length;
        const newCount = segment.filter(line => line.kind !== '-').length;
        const first = segment[0]!;
        const firstOld = segment.find(line => line.kind !== '+');
        const firstNew = segment.find(line => line.kind !== '-');
        // A zero-length side of a unified hunk points to the preceding line.
        const oldStart = firstOld ? firstOld.oldLine : Math.max(0, first.oldLine - 1);
        const newStart = firstNew ? firstNew.newLine : Math.max(0, first.newLine - 1);
        patches.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${segment.map(line => line.kind + line.code).join('\n')}`);
      }
      segment = [];
    };

    for (const line of hunk.lines) {
      const belongs = line.kind === '-'
        ? within(line.oldLine, previousEntity)
        : line.kind === '+'
          ? within(line.newLine, entity)
          : within(line.newLine, entity) && within(line.oldLine, previousEntity);
      if (!belongs) {
        // A replacement lists all removals before additions, including neighboring
        // functions. Keep this entity's paired sides together across excluded edits.
        if (line.kind === ' ') flush();
        continue;
      }
      segment.push(line);
      if (line.kind === '+') addedCode.push(line.code);
      if (line.kind === '-') removedCode.push(line.code);
      if (line.kind !== ' ') changedLines.add(Math.min(entity.endLine, Math.max(entity.startLine, line.newLine)));
    }
    flush();
  }

  if (!addedCode.length && !removedCode.length) return undefined;
  return {
    file: file.file,
    changedLines: [...changedLines].sort((a, b) => a - b),
    addedCode,
    removedCode,
    // Do not reuse Git's hunk heading: it can name an unrelated neighboring function.
    diff: `--- ${file.oldFile ? `a/${file.oldFile}` : '/dev/null'}\n+++ b/${file.file}\n${patches.join('\n')}`,
  };
}
