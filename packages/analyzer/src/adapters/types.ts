import type * as ts from 'typescript';
import type { Entity } from '../contracts';
import type { AccessHint, SurfaceKind, SurfaceSource } from '../application-map';

/** Result of cheap framework detection; `present: false` lets the host skip `surfaces`. */
export interface Detection {
  present: boolean;
  evidence?: string[];
}

/** A source (non-test) file visible to adapters. */
export interface AdapterSourceFile {
  sourceFile: ts.SourceFile;
  /** Project-relative path (forward slashes). */
  file: string;
  /** Position in the analyzed file list; adapters use it to keep a stable discovery order. */
  index: number;
  /** Package names declared by this file's nearest package.json files. */
  dependencies: Set<string>;
}

export interface RedirectLink { node: ts.Node; target: string; from?: string }

/**
 * A surface found by an adapter, before entry scanning. `order` is compared lexicographically by
 * the host so the merged discovery order is independent of adapter order.
 */
export interface DetectedSurface {
  kind: SurfaceKind;
  route: string;
  method?: string;
  source: SurfaceSource;
  node: ts.Node;
  entry?: ts.Expression | ts.Node;
  entrySymbol?: ts.Symbol;
  access: AccessHint[];
  labels: string[];
  order: readonly number[];
}

/** Shared TypeScript program, checker, and symbol helpers handed to every adapter. */
export interface AdapterContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Analyzed, non-declaration source files (includes tests). */
  sourceFiles: ts.SourceFile[];
  /** Analyzed source files that are not tests, in discovery order. */
  files: AdapterSourceFile[];
  projectRoot: string;
  entities: Entity[];
  symbolToEntity: Map<ts.Symbol, Entity>;
  entityDeclaration: Map<string, ts.Node>;
  entityForDeclaration: Map<ts.Node, Entity>;
  /** Frameworks seen so far; adapters may add the frameworks they recognise. */
  frameworks: Set<string>;
  /** Redirect links discovered in route configuration (merged into navigation by the host). */
  redirectLinks: RedirectLink[];
  toProjectPath: (fileName: string) => string;
  relativeOf: (node: ts.Node) => string;
  inAnalyzed: (node: ts.Node) => boolean;
  resolve: (node: ts.Node) => ts.Symbol | undefined;
  symbolOf: (expression: ts.Node) => ts.Symbol | undefined;
  declarationBody: (symbol: ts.Symbol, hops?: number) => ts.Node | undefined;
  resolveConstant: (expression: ts.Expression) => ts.Expression | undefined;
  /** String value of an expression, following constants. */
  str: (expression: ts.Expression | undefined) => string | undefined;
  moduleDefault: (specifier: ts.Expression | undefined) => ts.Symbol | undefined;
  sourceFileExport: (sourceFile: ts.SourceFile, name: string) => ts.Symbol | undefined;
  /** Computes a value once per extraction and shares it between adapters. */
  memo: <T>(key: string, factory: () => T) => T;
}

export interface FrameworkAdapter {
  /** Stable, unique id; also the folder name under `src/adapters`. */
  id: string;
  /** Bump when the adapter's output can change (recorded as surface provenance). */
  version: string;
  /** Framework/package names this adapter understands. */
  frameworks: string[];
  detect(ctx: AdapterContext): Detection;
  surfaces(ctx: AdapterContext): DetectedSurface[];
}

export const ADAPTER_VERSION = '1.0.0';

export function compareOrder(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Detection by declared dependency: present when any non-test file sees one of `packages`. */
export function detectByDependency(ctx: AdapterContext, packages: readonly string[]): Detection {
  const evidence = packages.filter(name => ctx.files.some(file => file.dependencies.has(name)));
  return { present: evidence.length > 0, ...(evidence.length ? { evidence } : {}) };
}

/** Detection for purely syntactic adapters (decorators, JSX, route objects): always run. */
export function detectSyntactic(): Detection {
  return { present: true, evidence: ['syntactic'] };
}
