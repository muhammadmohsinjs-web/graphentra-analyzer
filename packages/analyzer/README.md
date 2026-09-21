# @graphentra/analyzer

Deterministic change-evidence and graph analyzer for TypeScript repositories.

## Overview

`@graphentra/analyzer` extracts:
- A technical `CALLS` graph of TypeScript function declarations.
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
```

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
