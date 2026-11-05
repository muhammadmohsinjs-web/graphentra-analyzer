# Gap register

Every thing Graphentra misses on a real commit gets one record here, with a cause, the evidence and a test that pins it.
This folder is the source of truth. Roadmap notes and tasks link to a gap id and do not copy the record.

```
npm run bench:gaps -- record excalidraw-11   # impactbench/runs/<id>/graphentra-evidence.json -> graphentra-result.json
npm run bench:gaps -- check                  # also runs in verify:all
npm run bench:gaps -- summary                # counts by cause, recall so far
```

## The loop

1. Run Graphentra on a corpus commit, save the evidence, then `record` it.
2. `check` fails on every missed truth entity that has no gap. Add it to an existing gap or open a new one.
3. Find the cause from the code and the saved output, not from a guess. Write what you checked in `evidence`.
4. Pin the gap with a test that asserts today's miss. See `known-gaps.test.ts` in the analyzer and reporting packages.
5. Use `summary` to choose the next fix by how many entries a cause affects, then link the roadmap task in `roadmapTask`.
6. A fix makes the pin fail. Change the test to assert the new behavior, set `status: "fixed"` and `fixedIn`, and record the
   numbers from the whole corpus.

## What `check` enforces

- Each record is valid, and each `foundIn` and `missed` value exists in the D-0 corpus.
- Each gap has `pinnedBy`, or `pinExempt` with a reason. LLM output cannot be pinned by a unit test.
- A miss with no gap fails. This covers truth entities only; findings about the report are added by hand.
- A fixed gap that is missed again fails.
- An open gap whose entity is now found fails, so the register cannot go stale.
- A `limitation` must be a sentence in `packages/analyzer/src/output.ts`.
- An open gap with no `limitation` or `roadmapTask` is a warning. It means the gap is not disclosed or not planned.

## Causes

| Cause | Meaning |
|---|---|
| `entity-collection` | The code has no entity (the corpus `collectorGap` flag) |
| `traversal-direction` | The link is in the graph, but the impact walk does not follow it that way |
| `data-flow` | The graph has no link, because the effect travels by a value and not by a call |
| `report-context` | The analyzer has the fact, but the report payload does not carry it |
| `model-reasoning` | The payload carries the fact, but the report does not use it |
| `truth-error` | The miss is an error in the corpus truth. Record the correction in the entry's `review` field |

## Rules

- Do not change the corpus truth to close a gap. See the rules in `impactbench/corpus/README.md`.
- A gap is what we saw on real commits, so a cause seen on one entry is a lead and not a rule. `summary` shows how far it reaches.
- Close a gap only with whole-corpus numbers: a fix that adds more noise than it finds is not a fix.
