/** Bounds on untrusted repository input (fork PRs in customer CI). Input-size based only: there is no wall-clock stop. */
export interface InputLimits {
  /** Files larger than this are skipped without being read. */
  maxFileBytes: number;
  /** Analyzable files kept, first N by sorted path. */
  maxFiles: number;
  /** Total bytes of analyzable files kept, first by sorted path. */
  maxTotalBytes: number;
}

export const DEFAULT_INPUT_LIMITS: InputLimits = {
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 50_000,
  maxTotalBytes: 500 * 1024 * 1024,
};

/** `parse_failed`: the TypeScript parser overflowed its stack (for example on thousands of nested parentheses). */
export type SkipReason = 'too_large' | 'binary' | 'invalid_encoding' | 'symlink' | 'input_limit' | 'parse_failed';

/** One input the analyzer refused to read; `file` is project-relative with `/` separators. */
export interface SkippedInput {
  file: string;
  reason: SkipReason;
}

const BINARY_SNIFF_BYTES = 8 * 1024;

/** A NUL byte in the first 8 KB means binary; otherwise the bytes must be strict UTF-8. */
export function inspectContent(buffer: Buffer): 'ok' | 'binary' | 'invalid_encoding' {
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 'binary';
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return 'invalid_encoding'; }
  return 'ok';
}
