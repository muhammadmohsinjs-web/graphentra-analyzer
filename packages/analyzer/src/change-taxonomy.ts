import * as ts from 'typescript';
import { exportSurfaceOf, fingerprint, normalizeNode, signatureOf } from './ast-normalize';
import { isTestPath } from './application-map-ast';
import type { ChangeClass, ChangeKind } from './contracts';

export interface EntityFingerprints {
  full: string;
  noLogs: string;
  signature: string;
  exportSurface: string;
}

export interface ClassifyChangeInput {
  changeKind: ChangeKind;
  file: string;
  base?: EntityFingerprints;
  head?: EntityFingerprints;
}

/** Fingerprints of one entity node (node needs parent pointers). `full` keeps parameter names, so a param rename is never cosmetic. */
export function fingerprintsOf(node: ts.Node): EntityFingerprints {
  return {
    full: fingerprint(normalizeNode(node)),
    noLogs: fingerprint(normalizeNode(node, { dropLogCalls: true })),
    signature: fingerprint(signatureOf(node)),
    exportSurface: exportSurfaceOf(node),
  };
}

/**
 * Conservative change classification (D9): escalate whenever unsure, never return an empty array.
 * signatureOf includes export modifiers, so adding/removing `export` yields both 'signature' and 'export_surface'.
 */
export function classifyChange(input: ClassifyChangeInput): ChangeClass[] {
  const classes = new Set<ChangeClass>();
  const { changeKind, base, head } = input;

  if (changeKind === 'added') classes.add('added');
  else if (changeKind === 'deleted') classes.add('deleted');
  else {
    if (changeKind === 'renamed') classes.add('renamed');
    if (!base || !head) {
      classes.add('body');
    } else {
      const signatureChanged = base.signature !== head.signature;
      const exportChanged = base.exportSurface !== head.exportSurface;
      if (signatureChanged) classes.add('signature');
      if (exportChanged) classes.add('export_surface');
      if (base.full === head.full) {
        // Identical text: cosmetic only if nothing else applies; a pure rename stays 'renamed'.
        if (!signatureChanged && !exportChanged && changeKind !== 'renamed') classes.add('cosmetic');
      } else if (!signatureChanged) {
        if (base.noLogs !== head.noLogs) classes.add('body');
        else if (!exportChanged) classes.add('log_only');
      }
    }
  }

  if (isTestPath(input.file)) classes.add('test_only');
  if (classes.size === 0) classes.add('body');
  return [...classes].sort();
}
