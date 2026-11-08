# Video script: "Our tool found the bug. The AI still missed it."

Length: about 7 to 8 minutes. Format: talking head plus screen recordings and animated diagrams.
Each scene has the narration (what you say), the visual (what is on screen), and the illustration or footage to use.

Facts in this script come from `impactbench/gaps/gaps.json` (GAP-001, GAP-002, GAP-003), the excalidraw-11 corpus entry and `impactbench/gaps/value-flow-experiments.md`.
Numbers are small samples from one model (openai/gpt-6-luna). Say that on camera. It keeps the video honest.

---

## Scene 1. The hook (0:00 to 0:30)

**Narration**

> Here's a strange bug. Our analyzer looked at a real commit and found the exact function that would break.
> We gave that to an AI and asked it to write a QA test plan. The AI read it and still told the tester to check the wrong thing.
> The data was right and the answer was wrong. This video is about why that happens, and what we did about it.

**Visual**

- Split screen. Left: a JSON file with one line highlighted green, `"src/charts.ts#tryParseSpreadsheet", "flagged": "value"`. Right: the AI's report, with the line "Verify tabs display as eight spaces" highlighted red.
- Big text in the middle: "Right data. Wrong answer."

**Illustration**

- Screen recording of `graphentra-result.json` in your editor, zoomed in.
- A mock-up of the report in a simple card layout. Recreate it in Figma or Keynote; don't show a real ticket.

---

## Scene 2. The real bug (0:30 to 1:30)

**Narration**

> This happened in Excalidraw, the open-source whiteboard. In November 2022 a commit changed how copy and paste works with text.
> One small part of it cleaned up pasted text: it turned tab characters into spaces. That sounds harmless.
> But Excalidraw has a hidden feature. Copy rows from a spreadsheet, paste them on the canvas, and it offers to make a chart.
> How does it know you pasted a spreadsheet? It looks for tabs. Spreadsheets separate columns with tabs.
> So once tabs became spaces, the chart feature quietly stopped working. Three weeks later someone fixed it, with a commit called
> "chart pasting not working due to removing tab characters".

**Visual**

1. Screen recording: copy three rows from Google Sheets or Excel, paste into excalidraw.com, the chart dialog appears.
2. Animation of the text being pasted: `Month[TAB]Sales` shown with the tab drawn as a visible arrow →.
3. The "cleaner" turns each → into four grey dots (spaces).
4. The chart detector looks for → and finds none. Red X. "Not a spreadsheet."

**Illustration**

- Real screen recording of the chart paste in today's Excalidraw (it works now, so it shows the feature).
- A simple 3-box flow diagram: **Clipboard → Clean up text → Chart detector**. Animate the tabs disappearing in the middle box.
- Optional b-roll: close-up of a keyboard Tab key.

---

## Scene 3. Why this kind of bug is hard (1:30 to 2:30)

**Narration**

> Here's what makes this nasty. The code that broke, the chart detector, was not in the commit at all. Nobody touched it.
> It doesn't even call the function that changed. It just receives the text that comes out of it.
> Most impact tools work by following calls backward: "who calls the thing I changed?" The chart detector isn't a caller,
> it's a consumer. It sits downstream. So a backward walk never reaches it.

**Visual**

- A graph diagram. The changed function in orange in the middle.
- Arrows pointing up to callers, lighting up one by one ("callers: found").
- An arrow pointing down and sideways to the chart detector, which stays grey. Label: "Consumer: not found".

**Illustration**

- Animated node graph (Excalidraw itself is perfect for this, which is a nice touch; or use Motion Canvas / Keynote Magic Move).
- Use two colours only: orange for changed, green for found, grey for missed.

---

## Scene 4. Step one: we fixed the analyzer (2:30 to 3:30)

**Narration**

> So the first fix was in our analyzer. We taught it to follow values, not just calls.
> If a function's output changes, where does that output go? Into arguments, local variables, return values.
> We follow it one caller up and one call down, and we stop there, because going further added lots of noise and found nothing more.
> After that change, the analyzer flagged the chart detector. Across our test corpus, it went from finding 1 of 9 downstream consumers to 7 of 9.
> So now the evidence file had the answer. Problem solved? Not quite.

**Visual**

- Same graph as Scene 3. A glowing dot (the "value") travels from the changed function along the arrow into the chart detector, which turns green.
- Stat card: "Downstream consumers found: 1/9 → 7/9".
- Stat card: "Entities found overall: 57/78 → 71/78".

**Illustration**

- Animated "data packet" moving along an edge.
- Clean number cards, big font, one stat per card.

---

## Scene 5. The surprise: the AI still missed it (3:30 to 4:30)

**Narration**

> We feed this evidence to an LLM that writes a short test plan for a manual tester.
> The evidence said: this change reaches the chart detector. And the report said: "Verify tabs display as eight spaces."
> In other words, the AI checked that the change worked. It never asked what the change might break.
> We ran it twice without extra help. Zero out of two reports mentioned spreadsheet paste.

**Visual**

- Show the payload as a giant scrolling JSON wall. Somewhere in the middle, a tiny highlighted line: `receivesChangedValue: tryParseSpreadsheet`.
- Zoom out until that line is a single pixel.
- Then cut to the report card with "Verify tabs display as eight spaces".
- Counter: "0 / 2 reports mention chart paste".

**Illustration**

- Fast scroll of a real payload file (the excalidraw prompts are around 850 KB, so the scroll is long, which makes the point).
- "Needle in a haystack" metaphor: a haystack graphic with one glowing needle.

---

## Scene 6. Why the AI missed it: three reasons (4:30 to 6:00)

**Narration, intro**

> We dug into it. The model wasn't dumb. We set it up to fail, in three ways.

### Reason 1. We gave it data with no instructions

> The list of receivers was in the payload, but the prompt never said what a receiver is or what to do with it.
> Worse, the prompt listed what the AI must trust: callers, dependents, paths. Receivers were not on that list.
> So to the model, this was just another field it could ignore.

**Visual**: the prompt text on screen, with the "sole authority for…" sentence highlighted, and a visible blank where "receivers" should be.

### Reason 2. The one clue was buried

> For this commit, the analyzer found 39 code locations that receive the changed value. We sent all of them, unranked.
> And the one that mattered had no description. The file summaries came from a much newer version of Excalidraw,
> so the model saw a function name and nothing about what it does.

**Visual**: a list of 39 grey names. One of them is the chart detector, also grey, with an empty "description" bubble next to it.

### Reason 3. The prompt asks "did it change?" not "what relied on the old way?"

> This is the big one. A QA prompt naturally says: here's the change, test it. So the model tests that tabs become spaces.
> That's checking the new behaviour works. But this bug isn't in the new behaviour. It's in someone who depended on the old one.
> A good human tester asks: "Who needed those tabs?" Our prompt never asked the model that question.

**Visual**: two speech bubbles side by side. Left, the AI: "Do tabs turn into spaces? ✓". Right, a human tester: "Who needed those tabs?" The right bubble glows.

**Illustration for the whole scene**

- Number each reason with a big 1, 2, 3 that stays in the corner.
- Keep the code on screen short: one sentence of prompt, one list, two bubbles.

---

## Scene 7. What we changed, and how much it helped (6:00 to 6:45)

**Narration**

> So we changed three things in how we build the report input.
> One: we rank the receivers. Specific code in another file goes first, generic helpers go last, and we send at most eight.
> Two: each receiver comes with its meaning, when we have one.
> Three: we added a clear instruction. For each receiver, decide what it assumed about the old value. If it could break and a user would notice,
> add a check that uses input that relied on the old behaviour.
> Result: with receivers, 2 out of 3 reports mentioned spreadsheet paste, and 1 out of 3 had the exact check that catches the bug:
> paste spreadsheet rows, and the chart dialog should still open. Reports didn't get any longer.
> That's better, but it's not solved. Most runs still miss it, and three runs is a tiny sample.

**Visual**

- Before/after bar chart: "Mentions chart paste: 0 of 2 → 2 of 3". "Has the catching check: 0 → 1 of 3".
- A small card: "Report length: 2,660 → 2,673 characters (no change)".
- Big honest label: "Improved, not closed".

**Illustration**

- Simple bar chart, two colours. Make the sample size visible on the bars (n=2, n=3).

---

## Scene 8. How to raise the odds further (6:45 to 7:40)

**Narration**

> So how do we push this higher? Here's what's next. Some of these are tested, some are ideas, and I'll say which.

1. **Show the consumer's actual code.** *Idea, not yet tested.*
   > Right now the model only sees the name. If we show the one line that splits on tabs, the assumption is right there in front of it.
2. **Ask about removed guarantees directly.** *Idea.*
   > A dedicated step: "This change removes tabs. List everything that could have relied on tabs."
3. **Link features through files.** *Known gap, GAP-002.*
   > We have a feature called charts and paste that lists the clipboard file. But the report never gets it, because we only link features
   > through annotations and screens, and this repo has neither. Fixing that puts "chart paste" in the payload by name.
4. **Give the right descriptions.** *Known issue.*
   > Use file summaries from the same version as the commit, so the chart detector arrives with a meaning.
5. **Run it more than once.** *Idea.*
   > One run is a coin flip. Run the report several times, or add a second pass whose only job is to hunt for regressions, and merge what they find.
6. **Measure, don't guess.** *Process.*
   > LLM output isn't deterministic, so a unit test can't lock this in. We track it by re-running reports across the whole corpus.

**Visual**

- A checklist that fills in one item at a time, each tagged "tested" (green), "idea" (blue) or "known gap" (orange).

**Illustration**

- For item 1: show `split("\t")` with the `\t` glowing.
- For item 5: three report cards fanning out, then merging into one.

---

## Scene 9. The takeaway (7:40 to 8:00)

**Narration**

> The lesson for anyone building with LLMs: correct data isn't enough. If you don't tell the model what a fact means,
> rank it so it isn't buried, and ask the right question, it will answer the easy question instead.
> Our analyzer learned to find the code that breaks. Now we're teaching the AI to ask: "Who depended on the old way?"

**Visual**

- Back to the split screen from Scene 1. The red line on the right becomes: "Verify that pasting spreadsheet rows still opens the chart dialog". It turns green.
- End card: "Right data. Right question. Right answer."

**Illustration**

- Reuse the Scene 1 layout for a clean bookend.

---

## Asset checklist

| Asset | Where to get it | Used in |
|---|---|---|
| Spreadsheet paste → chart dialog recording | Record on excalidraw.com with Google Sheets | Scene 2 |
| Tab-to-spaces animation | Keynote or Motion Canvas; draw tabs as → | Scene 2 |
| Caller vs consumer graph | Draw in Excalidraw, animate with Keynote Magic Move | Scenes 3, 4 |
| `graphentra-result.json` zoom | Screen recording in your editor | Scenes 1, 4 |
| Long payload scroll | Screen recording of an excalidraw payload | Scene 5 |
| Prompt sentence close-up | `packages/reporting/src/qa-evidence.ts`, `qaInstruction` | Scene 6 |
| Before/after bar chart | Keynote or Figma, sample sizes on the bars | Scene 7 |
| Haystack and needle, Tab key b-roll | Stock sites (Pexels, Unsplash) | Scenes 2, 5 |

## Things to say carefully

- Every number comes from 2 or 3 runs of one model. Say "in our small test", not "the AI now catches it".
- The Excalidraw bug was found and fixed by its maintainers in 2022. Our tool is re-checking history; it did not find a new bug in Excalidraw.
- Show Excalidraw's UI as a real product being studied, without suggesting they endorse Graphentra.
