# @graphentra/analyzer

Deterministic change-evidence and graph analyzer for TypeScript repositories.

## Overview

`@graphentra/analyzer` extracts:
- A technical `CALLS` graph of TypeScript and JavaScript entities: functions (declarations and variable-bound arrows), class and object-literal methods, React components, and one `<module>` entity per file.
- Entity-attributed Git change evidence (additions, deletions, line coordinates).
- Reverse dependency reachability and blast-radius traversal (up to depth 6).

It operates completely offline without LLM credentials, network access, or external databases.

## Usage

### CLI

```sh
# Compare commits
graphentra-analyze --target /path/to/repo --base main --head feature-branch

# Compare working tree
graphentra-analyze --target /path/to/repo --working-tree

# Use the pre-0.5 engine (named function declarations only, evidence 2.0)
graphentra-analyze --target /path/to/repo --working-tree --engine legacy
```

### Engines

Since 0.5.0 the default engine is `extended`. It emits evidence `schemaVersion: "2.1"` with entity kinds `function`, `method`, `component` and `module`, a `language` field on each entity, a `toolchain` record, and `.js`/`.jsx`/`.mjs`/`.cjs` support. Entity IDs follow `<file>#<qualifiedName>` (see `docs/entity-identity.md`).

`--engine legacy` (or `engine: 'legacy'` in the library) keeps the previous behavior byte-for-byte: TypeScript named function declarations only, evidence `schemaVersion: "2.0"`. Use it as an escape hatch if a consumer cannot read 2.1 yet.

### Library

```ts
import { analyzeRepository } from '@graphentra/analyzer';

const result = analyzeRepository({
  target: '/path/to/repo',
  comparison: {
    base: 'HEAD~1',
    head: 'HEAD',
  },
});

console.log(result.outcome);
console.log(result.evidence);
```
