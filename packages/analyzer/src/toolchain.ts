import * as ts from 'typescript';
import type { DiagnosticItem } from './contracts';

/**
 * The exact TypeScript version the analyzer is pinned to (P0-10). A different parser version can
 * produce a different graph and identity hash for the same input, so a mismatch is reported.
 * Keep in sync with the exact `typescript` pin in every package.json (enforced by test/toolchain.test.ts).
 */
export const PINNED_TYPESCRIPT_VERSION = '5.8.2';

export function toolchainDiagnostics(runtimeTypeScriptVersion: string = ts.version): DiagnosticItem[] {
  if (runtimeTypeScriptVersion === PINNED_TYPESCRIPT_VERSION) return [];
  return [{ code: 'TOOLCHAIN_VERSION_MISMATCH', severity: 'warning',
    message: `TypeScript ${runtimeTypeScriptVersion} is loaded but the analyzer is pinned to ${PINNED_TYPESCRIPT_VERSION}. ` +
      'Graph and identity hash may differ from runs on the pinned version.' }];
}

/** Toolchain record stamped on extended (2.1) evidence; node is major-only so the identity ignores patch drift. */
export function buildToolchainRecord(): { typescript: string; node: string } {
  return { typescript: ts.version, node: `${process.versions.node.split('.')[0]}.x` };
}
