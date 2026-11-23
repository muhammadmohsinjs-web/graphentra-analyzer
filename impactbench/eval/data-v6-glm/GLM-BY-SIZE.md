# GLM-5.3 Flash by commit size (verify run, 31 commits)

Hand-graded, 3 reports per commit, 93 reports. Caught = at least 2 of 3 reports catch the bug. Data: `glm-commits-by-size.json`, `runs.jsonl`, `hand-grades-glm-vs-luna.jsonl`.

## Headline

- Commits caught: **12 of 31** (targets E1 >=13, E2 >=15 explained are not met; 10 explained)
- Reports catching the bug: 33 of 93; valid reports 86 of 93
- Mean score 4.9/10; total cost $1.75
- Commits >= 500 KB: 0 of 12 valid reports catch the bug; 2 commits (excalidraw-19, -20) exceed provider input limits

## By input size

| Size band | Commits | Caught | Reports catching | Reports explaining | Score | Input tokens | Cost/report | Seconds |
|---|---|---|---|---|---|---|---|---|
| Under 50 KB | 8 | 5 | 58% | 33% | 6.1 | 15,788 | $0.0078 | 391 |
| 50–250 KB | 13 | 5 | 33% | 36% | 4.9 | 84,686 | $0.0170 | 459 |
| 250–500 KB | 4 | 2 | 50% | 58% | 6.2 | 168,987 | $0.0227 | 340 |
| 500 KB–1 MB | 3 | 0 | 0% | 0% | 3.9 | 434,008 | $0.0392 | 577 |
| Over 1 MB | 3 | 0 | 0% | 0% | 1.3 | 871,195 | $0.0924 | 374 |

## All commits (smallest to largest input)

| Commit | Input KB | Result | Catches | Score | Input tokens | Seconds | Cost (3) | Known bug |
|---|---|---|---|---|---|---|---|---|
| json-server-02 | 4 | Caught | 3/3 | 7.0 | 3,074 | 250 | $0.011 | Creating a router from a database file path failed with "db.getState is not a function". |
| json-server-01 | 5 | Caught | 3/3 | 8.7 | 6,218 | 336 | $0.028 | GET /:resource/:id without _embed returned the resource with an extra empty "undefined" key. |
| excalidraw-07 | 13 | Caught | 3/3 | 8.3 | 5,976 | 269 | $0.011 | Pressing Escape with the eraser tool active did not reliably return to the previous tool, and restoring saved appState did not normalize activeTool.lastActiveToolBeforeEraser. |
| ofetch-01 | 19 | Missed | 0/3 | 4.7 | 12,811 | 413 | $0.017 | The fetch function supplied to createFetch was invoked as a method of globalOptions, so it ran with the wrong receiver. |
| pathe-01 | 23 | Caught once | 1/3 | 4.3 | 18,903 | 1039 | $0.036 | extname returned wrong results for dotfiles and edge names such as ".foo", "..", ".", "./" and "..foo". |
| ofetch-02 | 28 | Caught | 2/3 | 6.3 | 26,940 | 711 | $0.029 | Responses with JSON-style content types such as application/vnd.api+json were returned as blobs instead of parsed JSON. |
| consola-01 | 31 | Missed | 0/3 | 3.7 | 19,161 | 38 | $0.019 | A burst of identical throttled logs never printed its final "(repeated N times)" line unless a different log followed. |
| consola-02 | 35 | Caught | 2/3 | 5.7 | 34,262 | 290 | $0.030 | Log level taken from the CONSOLA_LEVEL environment variable was not passed to the instance defaults. |
| ufo-03 | 57 | Missed | 0/3 | 2.7 | 25,670 | 189 | $0.022 | withoutBase dropped the leading slash when the remainder started with a query, e.g. /api?test with base /api gave ?test. |
| excalidraw-08 | 93 | Caught | 3/3 | 9.0 | 44,568 | 292 | $0.039 | Keyboard navigation/shortcuts in the color picker could throw when the gallery parent element was missing. |
| excalidraw-14 | 104 | Missed | 0/3 | 4.0 | 71,894 | 244 | $0.040 | The send backward and send to back layer icons rendered incorrectly (not rotated) in Safari. |
| excalidraw-18 | 107 | Caught | 2/3 | 6.0 | 77,832 | 283 | $0.041 | The Excalidraw+ promo banner linked to the wrong destination (landing page and app URLs were swapped for signed-in vs guest users). |
| excalidraw-02 | 116 | Caught | 3/3 | 8.7 | 54,630 | 560 | $0.043 | The opacity slider jumped back to the default (100) when the selected element had opacity 0. |
| excalidraw-06 | 133 | Missed | 0/3 | 4.0 | 50,602 | 274 | $0.028 | Undo did not work correctly after selecting text bound to a container, since the text was re-wrapped on selection. |
| excalidraw-09 | 135 | Missed | 0/3 | 4.0 | 55,382 | 817 | $0.034 | Canvas rendering was throttled to animation frames, causing the canvas to lag behind or flicker while resizing the window. |
| excalidraw-03 | 177 | Caught | 2/3 | 6.7 | 115,735 | 701 | $0.067 | Tool buttons with a visible prop were hidden when they should show and shown when they should hide (mobile/zen mode). |
| excalidraw-16 | 203 | Caught | 3/3 | 8.7 | 77,076 | 431 | $0.048 | The eraser tool erased locked elements. |
| excalidraw-04 | 214 | Missed | 0/3 | 3.0 | 110,379 | 285 | $0.040 | Pasted charts could not be resized correctly because their axis/guide lines had no width/height. |
| ufo-02 | 227 | Missed | 0/3 | 1.7 | 133,956 | 642 | $0.094 | A numeric 0 query value was serialized as a key without a value instead of key=0. |
| consola-03 | 238 | Missed | 0/3 | 3.7 | 136,365 | 343 | $0.084 | The initial option on select and multiselect prompts was accepted by the types but ignored, so the preselected value was never applied. |
| ufo-01 | 249 | Missed | 0/3 | 2.0 | 146,828 | 909 | $0.085 | URLs with lowercase percent-encodings (e.g. %2f, %3f) were not normalized to uppercase. |
| excalidraw-01 | 314 | Missed | 0/3 | 4.0 | 126,036 | 351 | $0.080 | Clicking an element that sits inside an already selected element did not select it (the existing selection was kept). |
| excalidraw-15 | 330 | Caught | 3/3 | 9.0 | 127,411 | 346 | $0.035 | Hyperlinks and embed links containing &, <, > or quotes were stored with HTML entities (e.g. "test&amp;"), corrupting URLs. |
| excalidraw-11 | 457 | Caught | 3/3 | 8.8 | 179,063 | 334 | $0.075 | Pasting spreadsheet data (tab-separated) no longer produced a chart. |
| excalidraw-05 | 468 | Missed | 0/3 | 3.0 | 243,438 | 328 | $0.083 | Stats for nerds showed wrong x/y/width/height for a single selected linear element (line/arrow) because raw element x/y/width/height was used instead of the bounding box. |
| excalidraw-10 | 563 | Missed | 0/3 | 4.0 | 450,760 | 808 | $0.086 | Opening a shared-library URL in a background tab showed the "add library" confirmation prompt before the user focused the tab. |
| excalidraw-12 | 879 | Missed | 0/3 | 3.3 | 465,226 | 587 | $0.125 | The Clear canvas confirm dialog and Library menu open state used the global jotai store instead of the editor scope, so the confirm dialog did not work reliably (e.g. Ctrl+Delete shortcut). |
| excalidraw-17 | 1,066 | Missed | 0/3 | 4.3 | 386,038 | 335 | $0.142 | Keyboard shortcuts for the crowfoot-one and crowfoot-many arrowheads were swapped relative to their labels. |
| excalidraw-13 | 2,240 | Missed | 0/3 | 4.0 | 871,195 | 374 | $0.277 | The in-container text editor on Chrome-like browsers was 0.5px narrower than the rendered text, which could cause wrapping or position mismatch between editing and display. |
| excalidraw-19 | 3,049 | Input too large | 0/3 | 0.0 | - | - | $0.000 | Dragging the endpoint of an arrow bound inside a shape triggered the focus point editor instead of dragging the endpoint. |
| excalidraw-20 | 4,857 | Input too large | 0/3 | 0.0 | - | - | $0.000 | A rectangle that fully contained a frame was not treated as overlapping it, so dragging it over the frame did not add it as a child and box selection with frame clipping misbehaved. |

## Reading

- Small inputs (<50 KB) catch best; the 50-250 KB band dips; nothing above 500 KB is caught.
- Missed bugs mostly need a specific trigger the reports never use (value 0, lowercase percent-encoding, last log of a burst, Safari).
- Cost per report rises about 12x from the smallest to largest band; time does not track input size.

## Decisions to make

- Cap or chunk inputs above ~500 KB instead of sending them whole.
- Prompt the writer to enumerate edge-value triggers (0, empty, case, order) for each changed function.
