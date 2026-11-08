# Commit patterns in the D-0 corpus (32 entries)

Why this exists: excalidraw-11 taught us one pattern ("a change alters a value, and code the commit never touched relied on the old form").
This file shows how many of the 32 commits share that pattern, and what the other patterns are, so we choose the next commit by pattern.

How it was made (2026-11-08): each entry's symptom, evidence, `affected.entities[].outsideIntroducerDiff` and role in
`impactbench/corpus/d0-corpus.json`, plus the saved analyzer result in `impactbench/runs/<id>/graphentra-result.json`.
Each commit has exactly one primary pattern. This was done from the corpus summaries and not by re-reading all 32 diffs, so a few
placements are judgement calls (marked "close call"). The existing `changeClass` field in the corpus is a different cut (shape of the change);
this file groups by the mechanism of the bug.

## Summary

| Pattern | Commits | Where the bug is | Analyzer finds the faulty code? |
|---|---|---|---|
| A. Untouched code breaks because the change altered what it receives or relies on | 7 | **Outside** the diff | 13 of 17 outside-the-diff entities (missed: excalidraw-07 and excalidraw-09) |
| B. New logic does not handle an edge input | 8 | Inside the diff | Yes, all |
| C. Wrong value, swapped constant, inverted or too narrow condition | 5 | Inside the diff | Yes, all |
| D. New option or behaviour is not wired through | 6 | Inside the diff | Yes, all |
| E. A rewrite dropped an old guard or behaviour | 3 | Inside the diff | Yes, all |
| F. Timing, ordering or sync/async mistake | 3 | Inside the diff | Yes, all |

Takeaways:
- **Only 7 of 32 (22%) have the fault outside the diff.** In the other 25 the faulty function is one the commit changed, so
  the analyzer lists it trivially. For those, the open question is whether the report explains what is wrong, which is a reasoning
  problem and not a missing-evidence problem.
- **The exact excalidraw-11 pattern (a step removes something a consumer needs) appears in 1 commit.** Two more are close:
  excalidraw-15 and excalidraw-14. The new `reliesOnRemovedCharacters` check fires only on excalidraw-11 (see `progress.md`).
- So the work done so far covers about 1 to 3 commits of 32. Pattern A as a whole is the best next target, because it is where the
  analyzer is least certain and where the report has the most to add.

## A. Untouched code breaks because the change altered what it receives or relies on (7)

This is the family excalidraw-11 belongs to. Sub-patterns:

| Sub-pattern | Commit | What happened | Analyzer today |
|---|---|---|---|
| A1. A value or format is changed, consumers relied on the old form | **excalidraw-11** | Tabs turned into spaces; the spreadsheet parser needs tabs | Found (value flow). Report: about 90% caught |
| A1 | excalidraw-15 | Stricter HTML sanitization stored `&` as `&amp;`; links were corrupted for 5 untouched consumers (Hyperlink, paste, drop, restore) | Found as blast radius only. **Measured 2026-11-08: the report already catches it, 10 of 10 runs** (the new behaviour is itself the harm, so no gap). See `progress.md` |
| A1 (close call) | excalidraw-14 | Rotation moved from an SVG attribute to a CSS style, which Safari renders differently; the icon users are outside the diff | Found (value flow) |
| A2. A shared prop or helper is reused with new meaning | excalidraw-03 | Zen mode reused the `visible` prop; the tool buttons mapped it the wrong way (inverted class) | Found as blast radius only. Close call: also pattern C |
| A2 | excalidraw-20 | New overlap selection reused `isElementContainingFrame`, which could not handle a rectangle fully containing a frame | Found as blast radius only |
| A3. A state or timing path was not updated | excalidraw-07 | New eraser-return state was not normalized by `restoreAppState` | **Missed** (restoreAppState) |
| A3 | excalidraw-09 | Throttled rendering; `renderScene` and `componentDidMount` callers expected an immediate render after resizing | **Missed** (3 entities) |

Reading: A1 (3 commits) is what the value-flow work targets. A2 (2) is found only as blast radius, so the report must work out
that these callers matter. A3 (2) is where evidence itself is missing, so this is where the analyzer would need to change.

## B. New logic does not handle an edge input (8)

The commit's own new code works for the normal case and fails for an unusual input.

| Commit | Missing case |
|---|---|
| excalidraw-02 | Falsy value 0 (`||` instead of `??`) turned opacity 0 into the default |
| excalidraw-08 | Missing parent element (null) in the color picker |
| json-server-01 | `_embed` undefined produced an extra `undefined` key |
| ofetch-02 | Content types ending in `+json` were treated as blobs |
| pathe-01 | `extname` on dotfiles and names like `.foo`, `..`, `.` |
| ufo-01 | Lowercase percent encodings (`%2f`) not normalized |
| ufo-02 | Numeric 0 query value serialized without a value |
| ufo-03 | `withoutBase` dropped the leading slash when only a query remained |

Reading: the fix is a one-line condition in the same function. A good report names the edge case ("what about 0, empty, null, odd names?"),
so prompt guidance about boundary inputs is the lever here. Four of these (02, ufo-02, and similar) share "falsy check drops a valid 0".

## C. Wrong value, swapped constant, inverted or too narrow condition (5)

| Commit | Mistake |
|---|---|
| excalidraw-17 | Keyboard shortcuts for crowfoot-one and crowfoot-many swapped |
| excalidraw-18 | Landing page and app URLs swapped for signed-in vs guest |
| excalidraw-05 | Used the raw element x/y/width/height where the selection bounding box was needed |
| excalidraw-12 | Used the global jotai store instead of the editor scope |
| excalidraw-13 | Applied a 0.5px correction only on Firefox and Safari instead of every browser |

Reading: the bug is a plain mistake in changed code. Analyzer evidence cannot tell right from wrong here; only a reviewer comparing intent
with the code, or a test, can. Expect a low ceiling for any approach that is not "the model reads the code and notices a swap".

## D. New option or behaviour is not wired through (6)

| Commit | What was not wired |
|---|---|
| consola-02 | `CONSOLA_LEVEL` was not passed to the instance defaults |
| consola-03 | `initial` accepted by the types but never passed to select and multiselect |
| ofetch-01 | `fetch` called as a method of `globalOptions`, so it ran with the wrong receiver |
| excalidraw-04 | Pasted charts' axis lines had no width/height |
| excalidraw-19 | New focus-point editor took priority over endpoint dragging |
| excalidraw-21 | Custom tool not treated as pointer-capturing in view mode |

Reading: a new feature is half connected. A prompt question like "for each new option or mode, where is it consumed?" is the lever.

## E. A rewrite dropped an old guard or behaviour (3)

| Commit | What was lost |
|---|---|
| excalidraw-16 | Rewritten eraser trail dropped the "skip locked elements" check |
| excalidraw-01 | Immutable rewrite kept the old selection instead of clearing it (hit test added) |
| excalidraw-06 | Conditional text re-wrap on selection broke undo (close call: also pattern A) |

Reading: closest cousin of excalidraw-11, where the loss is inside the diff. A diff-level question works: "what did the old code do that the new code does not?"

## F. Timing, ordering or sync/async mistake (3)

| Commit | Mistake |
|---|---|
| consola-01 | The last "repeated N times" line was never flushed (no expiry timer) |
| excalidraw-10 | The library prompt appeared before the tab was focused |
| json-server-02 | Switching the database adapter to async broke a sync API (`db.getState is not a function`) |

## What this means for choosing the next commit

1. **Pattern A is the best target.** Its 7 commits are the only ones where evidence from the analyzer can decide the outcome, and two
   (07, 09) are still missed by the analyzer.
2. **excalidraw-15 was measured first and needs no work** (10 of 10 caught on the shipped code), so pattern A1 is two kinds: "the new
   behaviour is the harm" (handled) and "the harm is a property the change removed" (excalidraw-11, needed the new check).
3. **Next: excalidraw-07 and excalidraw-09** (A3) for analyzer gaps: these two have the fault outside the diff with no flag at all.
   Measure the report on them first, as was done for excalidraw-15, before changing anything.
4. **Patterns B to F (25 commits) need a different approach**: the faulty code is already in the evidence, so the open question is
   whether the report says what is wrong. Measure this once on a few commits (for example ufo-02, excalidraw-17, consola-03) before changing anything.
5. Per `README.md`, a fix to any pattern needs whole-corpus numbers before a gap closes.

## Caveats
- Placement is based on corpus summaries; re-read the diff before acting on a close call (excalidraw-03, 06, 14).
- `outsideIntroducerDiff` marks the code the bug-introducing commit did not touch. It counts only entities that the corpus truth lists.
- Counts are small. A pattern with 3 commits is a lead, not a rule.
