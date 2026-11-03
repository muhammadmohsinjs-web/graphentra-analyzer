# D-0 corpus: commits that later needed a fix

Ground truth for the Phase D scoreboard (D-1). Each entry is one real commit (the **introducer**)
that shipped a bug, and the later commit that fixed it. Contenders get the introducer diff only
and must say what deserves attention. The truth is what actually broke.

Roadmap: Obsidian `Phase D - Differentiation Against AI Reviewers` → D-0, D-1.

## How entries are found (SZZ)

1. `node tools/impactbench-corpus.mjs <history-dir> [repo ...] --out candidates.json` lists fix
   commits (subject says fix/bug/regression; at most 3 source files and 80 changed lines).
2. For each fix, it blames the parent's lines that the fix removed or replaced. The commit that
   wrote most of them is the candidate introducer. Formatting, rename and merge commits are dropped.
3. A person (or an agent, then a person) keeps a candidate only if the introducer really caused the
   bug: the fix restores behavior the introducer changed, not a bug that was always there.

4. Labeled candidates (one JSON array per batch, with `verdict` keep/reject) go in `parts/`.
   `node tools/impactbench-corpus.mjs merge impactbench/corpus/parts impactbench/corpus` validates
   them, assigns ids (`<repo>-NN`, by fix date) and writes `d0-corpus.json` plus `d0-rejected.json`
   (every rejected candidate with its reason, so the selection can be audited).

History clones are full-history and live outside the repo (the sandbox cannot write `.git` here):
`git clone --template= --filter=blob:none --no-checkout <url>`.

## Rules that keep the truth honest

- Write the entry **before** any contender runs on it. Never edit truth after seeing a score.
- Truth comes from the fix diff, the test the fix added, and the linked issue. Not from guesses.
- An entity is "affected" only if its observable behavior was wrong between introducer and fix.
- `outsideIntroducerDiff` marks affected entities the introducer did not touch. These are the hard
  cases: anyone can say "the changed function may be broken". D-1 reports recall on both sets.
- `fixAddedTest: true` with no test failing at the introducer means the suite stayed green.
  D-1 checks this by running the suite at the introducer.
- A second person checks at least 10 entries (`review` field). Disagreements are written down.

## Entry format (`d0-corpus.json`, an array)

```jsonc
{
  "id": "ufo-03",                          // <repo>-<nn>, stable
  "repo": "ufo",                           // folder name in the history dir
  "repoUrl": "https://github.com/unjs/ufo",
  "introducer": { "sha": "<40 hex>", "subject": "...", "date": "ISO" },
  "fix":        { "sha": "<40 hex>", "subject": "...", "date": "ISO", "issue": "#123 or null" },
  "changeClass": "plain-logic",            // see list below
  "symptom": "One sentence: what a user saw.",
  "affected": {
    "entities": [                          // Graphentra IDs at the introducer revision: file#qualifiedName
      { "id": "src/utils.ts#withQuery", "outsideIntroducerDiff": false, "role": "fault" },
      { "id": "src/url.ts#$URL.toString", "outsideIntroducerDiff": true, "role": "caller" }
    ],
    "areas": ["Building URLs with query params"]   // user-visible areas, for scoring free-text reviews
  },
  "fixAddedTest": true,
  "evidence": "Fix diff restores X; test added in test/query.test.ts asserts Y.",
  "confidence": "high",                    // high | medium | low: how sure the introducer caused it
  "review": { "by": null, "date": null, "agrees": null, "note": null }
}
```

`collectorGap: true` (optional) marks a real named symbol that Graphentra's extended collector does
not turn into an entity, e.g. `x = withBatchedUpdates(...)` or excalidraw's
`export const actionX = register({ perform, PanelComponent })`. The id keeps the true name; the
analyzer only sees that code as `<module>`. Keep these: they measure a known blind spot.
`node tools/impactbench-corpus.mjs verify impactbench/corpus/d0-corpus.json <history-dir>` checks
that every other id exists in the collector output at the introducer revision.

`role`: `fault` (the code the fix changed), `caller` (public API or caller whose output was wrong),
`consumer` (reads data or config the introducer changed, e.g. a storage key).

`changeClass` (one per entry, the class of the **introducer** change):

| Class | Meaning |
|---|---|
| `persisted-key` | Name or shape of stored data changed (localStorage, cookie, file, DB key) |
| `timing-limit-constant` | Timeout, debounce, retry, size limit or other tuning constant |
| `protocol-enum` | Enum member, message type, status code, event name |
| `client-server-pair` | A value that must match on both sides of a boundary |
| `return-shape` | Return value or object shape changed |
| `same-signature-behavior` | Behavior changed, types and signature did not |
| `default-option` | Default value of an option or argument changed |
| `plain-logic` | Ordinary logic bug inside the changed code |
