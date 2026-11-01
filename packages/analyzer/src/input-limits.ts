import * as ts from 'typescript';

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

/** D14: parser stack depth is not deterministic, so nesting is measured on tokens and files deeper than this are not parsed. */
export const MAX_NESTING_DEPTH = 500;

const EXPRESSION_END = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier, ts.SyntaxKind.PrivateIdentifier, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.ThisKeyword, ts.SyntaxKind.SuperKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword, ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken,
]);

/**
 * Maximum nesting of `(`, `[` and `{` (template substitutions count as braces), measured with the TypeScript scanner.
 * Iterative and independent of the call stack, so the result is the same on every machine. Returns early above `limit`.
 */
export function bracketNestingDepth(content: string, limit: number = MAX_NESTING_DEPTH): number {
  // Cheap pre-check: reaching `limit + 1` levels needs at least that many opening characters.
  let openers = 0;
  for (let i = 0; i < content.length && openers <= limit; i++) {
    const code = content.charCodeAt(i);
    if (code === 40 || code === 91 || code === 123) openers++;
  }
  if (openers <= limit) return 0;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content);
  const templates: number[] = [];
  let depth = 0;
  let max = 0;
  let previous = ts.SyntaxKind.Unknown;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if ((token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) && !EXPRESSION_END.has(previous)) {
      token = scanner.reScanSlashToken();
    } else if (token === ts.SyntaxKind.CloseBraceToken && templates.length > 0 && templates[templates.length - 1] === depth) {
      token = scanner.reScanTemplateToken(false);
      if (token === ts.SyntaxKind.TemplateTail) { templates.pop(); depth--; }
    }
    switch (token) {
      case ts.SyntaxKind.OpenParenToken:
      case ts.SyntaxKind.OpenBracketToken:
      case ts.SyntaxKind.OpenBraceToken:
        if (++depth > max) max = depth;
        break;
      case ts.SyntaxKind.TemplateHead:
        templates.push(++depth);
        if (depth > max) max = depth;
        break;
      case ts.SyntaxKind.CloseParenToken:
      case ts.SyntaxKind.CloseBracketToken:
      case ts.SyntaxKind.CloseBraceToken:
        if (depth > 0) depth--;
        break;
    }
    if (max > limit) return max;
    previous = token;
  }
  return max;
}
