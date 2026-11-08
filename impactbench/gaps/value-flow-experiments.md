# Value-flow experiments

How GAP-001 was closed, and why this approach and not another. Every row ran on the 5 simple-shop scenarios and all 32 D-0 corpus entries.
"Added" is the entities an approach lists beyond the walk toward callers, per corpus entry.

Rounds 1 to 3 ran before the collector change, so compare them with the first row. Round 4 is the same corpus after it.

| Round | Approach | Shop found (of 9) | Shop wrong (of 16) | All (of 78) | Outside diff (of 17) | Consumers (of 9) | Added mean / median / max |
|---|---|---|---|---|---|---|---|
| Start | Walk toward callers only | 0 | 0 | 57 | 6 | 1 | 0 / 0 / 0 |
| 1 | Forward 1 step | 2 | 7 | 58 | 7 | 1 | 73.5 / 46 / 363 |
| 1 | Forward 2 steps | 3 | 7 | 59 | 8 | 2 | 141.4 / 85 / 721 |
| 1 | Forward 3 steps | 3 | 7 | 59 | 8 | 2 | 197.8 / 107 / 991 |
| 1 | Callers, then forward 2 | 6 | 13 | 59 | 8 | 2 | 190.3 / 93 / 1029 |
| 1 | Sibling callees filtered by type | 2 | 2 | 57 | 6 | 1 | 5.3 / 1 / 33 |
| 1 | Writes matched to reads of a field | 0 | 0 | 57 | 6 | 1 | 1.2 / 0 / 14 |
| 1 | Value flow from return values | 3 | 0 | 58 | 7 | 2 | 8.2 / 0 / 61 |
| 2 | Value flow from changed lines and constants, any caller of a helper | 9 | 0 | 59 | 8 | 2 | 49.1 / 23 / 189 |
| 3 | Same, tracked back only to the call that passed the value | 9 | 0 | 59 | 8 | 2 | 13.4 / 5 / 82 |
| 3 | Same, one more call down | 9 | 0 | 59 | 8 | 2 | 17.4 / 5 / 105 |
| 3 | Same, following object fields | 9 | 0 | 59 | 8 | 2 | 28.5 / 5 / 220 |
| 4 | Collector change only | 0 | 0 | 68 | 10 | 4 | 0 / 0 / 0 |
| 4 | **Collector change plus value flow (shipped)** | **9** | **0** | **71** | **13** | **7** | **13.5 / 5 / 84** |

What decided it:

- A plain walk follows every call, so it flags functions that get nothing new. It found about as much as value flow at 5 to 15 times the noise.
- Tracking a value back only to the call that passed it cut the noise from 49 to 13 with no loss.
- Most real misses were functions the graph never collected: `register({ perform })` and `withBatchedUpdates(fn)`. Collecting those raised recall more than anything else.
- Deeper walks and object fields added noise and found nothing more, so the limits are one caller up and one call down.

Limits of these numbers:

- The corpus only lists what broke, so an added entity that isn't in the truth is not proven wrong. "Added" measures reading cost, not false alarms.
- Few misses separate the approaches, and all the real ones are in excalidraw, so the limits may need another look as the corpus grows.
- The field-matching prototype was not tuned, so its result is weak evidence.

## What QA reports get

`evidence.json` keeps the full list. The report gets at most 8 receivers per change, specific code in other files first, with each one's meaning, and a count of what was left out. The report format was already capped at 5 test areas with 4 checks each, and it never names functions, so a long list can't reach a tester directly.

Real reports, with and without receivers. The final instruction ran 2 or 3 times per case, and these are small samples of one model:

| Case | What the bug needs | Without receivers | With receivers |
|---|---|---|---|
| excalidraw-11, chart paste | A check that pasting spreadsheet rows still opens the chart flow | 0 of 2 mention it | 2 of 3 mention it, 1 of 3 has the check that catches it |
| Shop, price table | Say where the wrong price lands | 2 of 2 check the stored price and say its use is unknown | Run 1 of 2 read: checks the amount charged |
| Shop, customer title | Notice the greeting uses the first word | 2 of 2 check that the title appears | Run 1 of 2 read: same check, and it raises the first-name conflict as an open question |

| Measure | Without | With |
|---|---|---|
| Excalidraw report length, characters, mean (excalidraw-11, -14, -06) | 2,660 | 2,673 |
| Checks per report, mean | 6.0 | 5.7 |
| Prompt size, 21 excalidraw commits, mean | 848 KB | 852 KB (+0.5%) |

excalidraw-11 ran with file summaries from a much newer excalidraw, so its main consumer had a name but no description. A context from that commit could do better or worse.

## Raising the chance the report names the consumer (GAP-003, 2026-11-08)

Same commit every time (excalidraw-11), `deepseek/deepseek-v4.1-flash-1017`, a second model grading each check. A report is a catch only if one check normal-pastes spreadsheet cells and expects the chart flow; checks about plain paste or comma-separated data do not count. "Explained" means the report says the tab change could break spreadsheet detection. Runs that returned no valid report are listed apart: they catch nothing.

| Setup | Valid reports | Caught | Explained | No report |
|---|---|---|---|---|
| Raw receiver list, no instruction | 9 | 5 | 1 | 1 |
| Ranked receivers + instruction | 9 | 5 | 4 | 1 |
| + meaning of the receiver | 10 | 9 | 3 | 0 |
| + "what did the old value guarantee" instruction | 10 | 7 | 8 | 0 |
| + receiver source code | 6 | 2 | 2 | 4 |
| + a separate risk-hunting pass (with source code) | 6 | 6 | 4 | 4 |
| Analyzer note only | 9 | 8 | 9 | 1 |
| Analyzer note + all of the above | 8 | 7 | 8 | 2 |
| **Analyzer note + meaning** | **18** | **18** | **18** | **2 of 20** |
| Analyzer note + meaning + guarantees instruction | 18 | 18 | 18 | 2 of 20 |

What decided it:

- The analyzer note is the part that matters: when the changed code stops passing a character (here, tab) and a receiver splits or searches on it, the evidence says so. It costs no model call.
- Showing the receiver's source made things worse. The model copied identifiers into its checks, and the report format rejects those.
- Instructions alone moved the explanation rate but not reliably the catch rate.
- The note fires on 1 of 32 corpus commits (excalidraw-11) and on no other, so it adds no noise there.
- Limits: one commit, one model, one grader. The note only knows six characters (tab, newline, carriage return, comma, semicolon, pipe). 2 of 20 runs per setup had no valid report, so the ceiling for attempts is about 90% until empty or rejected reports are retried.

Reproduce the shipped row with `npm run bench:corpus -- <history-dir>`.
