import type { ChangedEntity, ChangedFile } from './contracts';

export interface AttributionResult {
  total: number;
  code: number;
  module: number;
  unattributed: number;
  ratio: number;
}

const nonBlank = (line: string): boolean => line.trim() !== '';
const countNonBlank = (lines: string[]): number => lines.filter(nonBlank).length;

/** Share of changed (non-blank) diff lines that land on a code entity. Innermost ownership means no double counting. */
export function computeAttribution(changedFiles: ChangedFile[], changedEntities: ChangedEntity[]): AttributionResult {
  let total = 0;
  for (const file of changedFiles) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) if (line.kind !== ' ' && nonBlank(line.code)) total++;
    }
  }
  let code = 0;
  let module = 0;
  for (const { entity, change } of changedEntities) {
    const count = countNonBlank(change.addedCode) + countNonBlank(change.removedCode);
    if (entity.kind === 'module') module += count;
    else code += count;
  }
  const ratio = total === 0 ? 1 : Math.round((code / total) * 10000) / 10000;
  return { total, code, module, unattributed: Math.max(0, total - code - module), ratio };
}
