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

Reproduce the shipped row with `npm run bench:corpus -- <history-dir>`.
