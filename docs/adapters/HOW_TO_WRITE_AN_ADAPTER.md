# How to write a framework adapter

Adapters turn framework conventions into application-map surfaces (UI routes and API endpoints).
Each lives in `packages/analyzer/src/adapters/<id>/index.ts`; `extractApplicationMap` in
`src/application-map.ts` is the host that runs them (plan decision D15).

## Interface

`src/adapters/types.ts`:

```ts
interface FrameworkAdapter {
  id: string;            // unique, equals the folder name
  version: string;       // semver, bump when output can change
  frameworks: string[];  // package names the adapter understands
  detect(ctx: AdapterContext): { present: boolean; evidence?: string[] };
  surfaces(ctx: AdapterContext): DetectedSurface[];
}
```

`AdapterContext` carries the TypeScript `program` and `checker`, the analyzed `sourceFiles`, the
non-test `files` (project path, index, package dependencies), and the shared helpers `resolve`,
`symbolOf`, `declarationBody`, `resolveConstant`, `str` (string value following constants),
`sourceFileExport`, `relativeOf`, entity maps, and `memo` for work shared between adapters.
AST helpers that take the context (`isHandlerLike`, `guardHintsFromObject`, JSX attribute helpers)
are in `src/adapters/shared.ts`. Adapters may add to `ctx.frameworks` and, for route configs,
`ctx.redirectLinks`.

A `DetectedSurface` is the surface before entry scanning: kind, route, method, `source`, the AST
node, the entry (an expression or an exported symbol), access hints, labels, and `order`.

## Registry order

`src/adapters/registry.ts` lists every adapter, sorted by `id` with `compareStrings` (never
`localeCompare`). The host runs `detect`, skips adapters that report `present: false`, calls
`surfaces`, then stable-sorts all results by `order` (compared lexicographically). Use
`[0, file.index, node.pos]` for file-local discovery (`-1` for file-system routing, which precedes
AST nodes in the same file). Cross-file registration models use `[1, sequence, 0]`. Same-id surfaces
merge in that order, so the first one decides `file`, `line`, and `source`.

The host records `{ adapterId, adapterVersion }` per surface id, first adapter wins, and returns it
from `extractApplicationMapWithProvenance`. It is never written to the ApplicationMap JSON.

## Declarative vs code adapters

- Declarative: route registration expressed as data and interpreted by a small engine. See
  `express-declarative/rules.ts`: `RouteRule` (methods, path/handler/middleware argument positions),
  `MountRule` (`use(prefix, router)`), `GuardRule`. Adding an Express-shaped router means adding a
  rule. Prefer this when the framework registers routes through ordinary calls.
- Code: file-system routing (`nextjs-*`), decorators (`nestjs`), JSX and route objects
  (`react-router`, `route-config`) walk the AST directly.
- Router adapters share `router-model.ts` because mount prefixes resolve across adapters. A
  collector records registrations, mounts, and guards into the sink, and the adapter returns its own
  registrations with `routerSurfaces(ctx, id)`. Each call shape must be claimed by exactly one
  adapter, or surfaces are duplicated.

## Versioning

Start at `1.0.0` (`ADAPTER_VERSION`). Bump the minor for new patterns, the patch for fixes, and the
major when existing surface ids or fields change. Any bump needs the golden updated in the same
change.

## Required with every adapter

1. A fixture under `packages/analyzer/test/fixtures/` exercising the framework (or a new case in an
   existing fixture).
2. A golden under `packages/analyzer/test/golden/` (`UPDATE_GOLDENS=1`), reviewed by hand.
3. A row in the capability table naming the adapter id, frameworks, and supported patterns.
4. A unit test `packages/analyzer/test/adapters/<id>.test.ts` with at least one positive case, using
   `mapFor` from `test/adapters/helper.ts`. Run with
   `npx tsx --test test/adapters/*.test.ts` (the default `npm test` glob does not descend).
5. A registry entry in `registry.ts`; `test/adapters/registry.test.ts` pins the id list.
