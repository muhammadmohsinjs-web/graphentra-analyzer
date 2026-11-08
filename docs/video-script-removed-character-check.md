# Video script: "The check that asks: who needed what we just removed?"

Length: about 4 to 5 minutes. Style: friendly explainer with simple flat illustrations and a few code close-ups.
Made for an AI video tool: each scene has a NARRATION block (paste into text-to-speech) and a VISUAL PROMPT block (paste into the image or video generator).

Visual style for every scene: flat vector illustration, soft pastel background, big readable text, three colours only. Orange means "changed", green means "working", red means "broken". No real brand logos. Characters are simple round-headed figures.

Facts come from `packages/analyzer/src/value-flow.ts` (the `reliesOnRemovedCharacters` check) and the Excalidraw commit "feat: changed text copy/paste behaviour (#5786)". The numbers come from one commit, so say "in our test" and not "always".

---

## Scene 1. A shopping list (0:00 to 0:40)

**NARRATION**

> Let's start with something simple. Imagine a shopping list app.
> You type: eggs, milk, bread. Three items, separated by commas.
> Somewhere in the app, a counter splits the list at every comma, and shows "3 items".
> Now someone on the team adds a tidy-up step. Their goal is harmless: "Replace commas with spaces so the list looks cleaner."
> The list becomes: eggs milk bread. Looks fine. But the counter still looks for commas. It finds none, and shows "1 item".
> Nobody touched the counter. It still works exactly as written. It just depended on something that is now gone.

**VISUAL PROMPT**

A phone screen showing a shopping list "eggs, milk, bread" and a green badge "3 items". Then an orange box labelled "Tidy-up" slides in and the commas turn into blank gaps. The badge changes to a red "1 item". A small speech bubble from the badge: "Where did my commas go?"

---

## Scene 2. The pattern, in one sentence (0:40 to 1:10)

**NARRATION**

> That is the whole idea in one sentence.
> A change removes something. Some other code was quietly counting on it.
> The change is correct. The other code is correct. Together, they break.
> The hard part: the broken code is not in the change. A reviewer looking at the diff sees nothing wrong.

**VISUAL PROMPT**

Three boxes in a row: "Change" (orange), "Value" (grey, a small card holding the text), "Other code" (starts green, turns red). A magnifying glass hovers over only the orange box with the caption "What a reviewer reads". The red box sits outside the glass, captioned "Where the bug is".

---

## Scene 3. The same thing in real software (1:10 to 2:10)

**NARRATION**

> This really happened in Excalidraw, the open-source whiteboard.
> A commit changed how pasted text is cleaned. One line turned every tab character into four spaces.
> Elsewhere in Excalidraw there is a feature: copy rows from a spreadsheet, paste them, and you get an offer to make a chart.
> How does it know it's a spreadsheet? Spreadsheets separate columns with tabs. The chart code splits the text at every tab.
> It is your shopping-list counter again. Tab is the comma. The chart feature is the counter.
> After the change, no tabs reached the chart code. The feature silently stopped working. Maintainers fixed it three weeks later.

**VISUAL PROMPT**

Left: a spreadsheet with three rows and two columns, a small arrow between the cells labelled "tab". Middle: the same text on a whiteboard canvas, with arrows replaced by four grey dots. Right: a chart dialog with a red cross, text "Not a spreadsheet". End on a split frame: "Shopping list: comma" next to "Excalidraw: tab" with an equals sign between them.

---

## Scene 4. Why a normal tool misses it (2:10 to 2:50)

**NARRATION**

> Most tools find impact by asking "who calls the thing I changed?"
> The chart code does not call the cleanup. It just receives the text that comes out of it.
> So walking backwards through calls never reaches it.
> Our analyzer already learned to follow values, not just calls: where does the output go? That finds the chart code.
> But finding it is not enough. Out of thirty-nine receivers, which one is the dangerous one?

**VISUAL PROMPT**

A graph. The changed function in orange in the middle. Arrows going up to callers that light up green with the label "callers: found". A thin arrow going sideways to a grey node "chart detector" with the label "receiver: not a caller". Then 38 more small grey nodes appear around it, with a question mark above the crowd.

---

## Scene 5. The new check, step by step (2:50 to 3:50)

**NARRATION**

> This is the new check. It has two steps, and both are plain pattern matching, not guessing.
> Step one: what did the change remove? We look for a replace call, where the pattern matches a character, like a tab, and the replacement text does not contain that character.
> Tab becomes spaces: the tab is removed. Newline becomes a newline: nothing is removed, so we say nothing.
> Step two: for each receiver, does it search on that same character? We look in the receiver, and one call below it, for things like split on tab, or includes tab.
> If both are true, the analyzer writes a note in the evidence file: this code relies on a removed character.
> The report builder turns that into a plain sentence, puts that receiver first, and tells the AI: this is the most likely regression. Add a check that pastes input that used to work.

**VISUAL PROMPT**

Two numbered panels.
Panel 1 "What was removed?": a code line `replace(/\t/g, "    ")` with the tab part glowing orange, and a green tick over "tab is gone". Below it, a second line `replace(/\n/g, "\n")` with a grey "nothing removed, ignore".
Panel 2 "Who needs it?": the code line `split("\t")` with `\t` glowing red, an arrow from panel 1's glowing tab to this one, and a stamp "relies on removed character".
Final frame: a file card labelled `evidence.json` with the line `"reliesOnRemovedCharacters": ["tab"]` highlighted, an arrow to a report card with the line "Verify that pasting spreadsheet rows still opens the chart dialog".

---

## Scene 6. Does it work? (3:50 to 4:20)

**NARRATION**

> On the Excalidraw commit, the AI report named the broken chart feature in about eighteen of twenty runs.
> Before the change it was five of nine, and it rarely explained why.
> We also scanned all thirty-two commits in our test set. The new check fired once, on this commit, and flagged nothing else.
> That is good news for noise. But it is one example, so we are careful about what we claim.

**VISUAL PROMPT**

Two bar charts side by side with the sample size on each bar: "Before: 5 of 9 caught, 1 of 9 explained" and "After: 18 of 20 caught". Below, a row of 32 small squares where one is orange and the other 31 are grey, captioned "Fired once in 32 commits".

---

## Scene 7. Honest limits (4:20 to 4:50)

**NARRATION**

> Three limits.
> It knows only six characters: tab, newline, carriage return, comma, semicolon and pipe.
> It looks only one call below the receiver.
> And it is a warning, not a verdict. It says "this may break", and the tester confirms.
> The next step is to run the report on all thirty-two commits, so we can say how well this works beyond one example.

**VISUAL PROMPT**

A simple checklist with three amber warning icons, each line fading in as it is read. The last line shows a progress bar "1 of 32 commits tested", with 31 empty slots.

---

## Scene 8. Closing line (4:50 to 5:00)

**NARRATION**

> When you change code, don't only ask "does my change work?" Ask: "who was counting on what I just took away?"

**VISUAL PROMPT**

Return to the shopping list from Scene 1. The counter now shows a green "3 items" again. End card text: "Who needed what you removed?"

---

## Asset checklist

| Asset | How to make it | Scene |
|---|---|---|
| Shopping list phone screen, counter badge | Generate as a flat illustration, or build in Figma | 1, 8 |
| Change, value, other-code boxes | Simple shapes in Keynote or Figma | 2 |
| Spreadsheet to canvas to chart dialog | Record the real chart paste on excalidraw.com, or illustrate | 3 |
| Call graph with 39 receivers | Draw in Excalidraw, animate with Magic Move | 4 |
| Code close-ups (`replace`, `split`) | Screenshot of `packages/analyzer/src/value-flow.ts` or a typed mock-up | 5 |
| Bar charts and 32 squares | Keynote or Figma, sample sizes written on the bars | 6 |

## Say carefully

- Say "in our test" and "on this commit". The result is from one commit, and the check was built after seeing it.
- Excalidraw's maintainers found and fixed this bug in 2022. Graphentra re-checks history and did not discover a new bug. Do not imply Excalidraw endorses Graphentra.
