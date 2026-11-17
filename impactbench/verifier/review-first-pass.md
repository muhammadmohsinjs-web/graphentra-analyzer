# Label review, first pass (2026-11-17)

These are suggestions for the 35 items that matter most for the V-3 gate. **They are not applied to `labels.jsonl`.** The labels change only when you confirm them.

- These suggestions come from reading each item's report and code. No model answers from the spike were used, so the answer key stays independent of the candidates.
- ⚑ means the suggestion differs from the draft label. Rows are sorted with the least certain first, so start at the top.
- **How to use:** write `ok`, `true` or `false` in "Your call". Then tell me, and I will apply the labels, set `reviewed: true` on those items, and mark the other 115 items reviewed if you agree.

## Coverage negatives (`judge-area`), 15 items, 13 suggested changes

The draft rule used the ImpactBench judge's `area` flag, which asks whether the report points at the **regression**, not whether it covers the **change**. That is why most of these flip to true.

| Item | Draft | Suggested | Conf. | Why (from the code) | Your call |
|---|---|---|---|---|---|
| `consola-02:v2-base-1` | false | **true** ⚑ | low | _createConsola builds the default instance, and key change 1 and check 1 cover "the default export is an initialized instance". The new behaviour inside it (CONSOLA_LEVEL, reporter choice) is only raised as an uncertainty, never tested. Your call: is the creation of the instance enough? | |
| `ufo-01:v2-base-1` | false | **false** | medium | The new encoding helpers (percent-encoding of #, &, /, = and so on) are never mentioned. The report covers repeated query keys and object input only. | |
| `excalidraw-01:v2-base-1` | false | **true** ⚑ | medium | App.render switches to immutable element updates, including the selection logic. Key change 1 describes this ('edits and selection-related actions replace the element list'), and check 2 exercises select, edit, undo. The reason given for false is the regression (click inside an already-selected element), not the change. | |
| `excalidraw-03:v1-lookup-always-2` | false | **false** | medium | The ToolButton visible prop switching from inline visibility to show/hide classes is not described. The report only says that Zen mode moves controls out of view. | |
| `consola-01:v1-base-1` | false | **true** ⚑ | high | Key change 1 and the QA check describe and test exactly what _logFn adds: counting suppressed repeats and emitting the "(repeated N times)" suffix. | |
| `consola-03:v1-lookup-1` | false | **true** ⚑ | high | prompt() is the new function, and the report covers all four prompt types (text, confirm, select, multiselect) with checks. | |
| `pathe-01:v2-base-1` | false | **true** ⚑ | high | Key change 2 names the custom extension logic, and check 1 tests extname('.env') directly. | |
| `ofetch-01:v2-base-1` | false | **true** ⚑ | high | The change adds $fetch.create with merged defaults, which is exactly key changes 1 and 2 and both checks. | |
| `excalidraw-02:v1-base-1` | false | **true** ⚑ | high | getFormValue is described by key change 1 (editing element first, then the common value, then the default), and checks 1 to 3 test it. | |
| `excalidraw-03:v2-base-1` | false | **true** ⚑ | high | Key change 2 describes the move from visibility styling to show/hide classes, and check 3 tests visible and hidden buttons. | |
| `excalidraw-09:v1-base-1` | false | **true** ⚑ | high | componentDidUpdate now uses renderSceneThrottled with a callback. Key changes 1 and 2 describe the throttling and the post-render scrollbar and image updates. | |
| `excalidraw-09:v2-base-1` | false | **true** ⚑ | high | Same change. Key change 1 and check 2 cover throttled rendering and the scrollbar and image refresh happening after the render. | |
| `excalidraw-04:v2-base-1` | false | **true** ⚑ | high | The new renderSpreadsheet layout (zero and max labels, axis lines, 256-unit bars) is key change 2 and check 3. | |
| `excalidraw-05:v2-base-1` | false | **true** ⚑ | high | The new Stats panel is key change 1, and checks 1 to 3 test its counts, bounds and single-element details. | |
| `excalidraw-05:v1-base-1` | false | **true** ⚑ | high | The new Stats panel is key changes 1 to 3, and checks 1 to 3 test it with exact values. | |

## Drafted true claims (`draft-own-report`), 20 items, 3 suggested changes

Each claim is the first key change of the report, checked against the BEFORE/AFTER evidence.

| Item | Draft | Suggested | Conf. | Why (from the code) | Your call |
|---|---|---|---|---|---|
| `consola-02:v2-base-1:0` | true | **false** ⚑ | medium | Only src/consola.ts used to default-export the class; the package entry src/index.ts had no default export before, and the old consola.node.ts default was already an instance (globalThis.consola = createConsola()), so 'changes from the logger class to an instance' is not what the evidence shows (package.json main is not in the evidence). | |
| `consola-03:v2-base-1:0` | true | **false** ⚑ | medium | createConsola(options) taking reporters was already public before (index.shared.ts exported it from ./consola, re-exported by index.ts), so 'can now be created with caller-supplied options' overstates; the real change is that the new index.ts/index.browser.ts createConsola adds env-based default reporters when options.reporters is missing. | |
| `excalidraw-10:v2-base-1:0` | true | **unsure** ⚑ | medium | In LibraryMenuItems>renderLibraryActions the AFTER shows only fragments ('await fileOpen({' with no closing line, and no assignment or updateLibrary call), so the evidence can show neither that the chosen file reaches the importer nor that it does not; the unchanged context lines of that onClick are missing. | |
| `excalidraw-16:v2-base-1:0` | true | **true** | medium | EraserTrail.updateElementsToBeErased takes the last POINTS_ON_TRAIL trail points and runs eraserTest (shape and segment intersection) over app.visibleElements, adding or removing (with altKey restore) whole groups, bound text and containers; group handling also existed before, so 'now' fits only the path/shape test. | |
| `json-server-01:v2-base-1:0` | true | **true** | medium | show() adds a req.query._embed block that sets resource[_embed] = db(_embed).where({<resource>Id: id}); the claim's 'attempt to' is fair because the forEach ignores its item and indexes with the whole array. | |
| `excalidraw-02:v2-base-1:0` | true | **true** | high | getFormValue returns editingElement attr \|\| getCommonAttributeOfSelectedElements \|\| defaultValue \|\| null, and actionChangeOpacity passes default 100, so an opacity of 0 is falsy and falls through to 100. | |
| `excalidraw-03:v2-base-1:0` | true | **true** | high | getDefaultAppState adds zenModeEnabled: false, onKeyDown toggles on altKey + Z without Ctrl/Cmd, LayerUI adds zen-mode-transition classes, and renderFooter adds a disable-zen-mode button that calls toggleZenMode. | |
| `excalidraw-05:v2-base-1:0` | true | **true** | high | openContextMenu adds a toggleStats item, showStats defaults to false, and the Stats component shows scene element count/size, local storage sizes, and the selected elements' x/y/width/height/angle. | |
| `excalidraw-07:v2-base-1:0` | true | **true** | high | actionErase.perform changed from isEraserActive ? 'selection' : 'eraser' to returning appState.activeTool.lastActiveToolBeforeEraser ?? 'selection', and it stores the previous tool type when turning the eraser on. | |
| `excalidraw-08:v2-base-1:0` | true | **true** | high | getCustomColors keeps non-deleted elements, sorts them by updated desc, and collects up to MAX_CUSTOM_COLORS=5 distinct colours not in the default palette; Picker returns [] when type === 'canvasBackground'. | |
| `excalidraw-09:v2-base-1:0` | true | **true** | high | componentDidUpdate replaces the synchronous renderScene call with renderSceneThrottled (throttleRAF with trailing: true), and the scrollBars/scrolledOutside/scheduleImageRefresh work moves into a callback that runs in the requestAnimationFrame. | |
| `excalidraw-11:v2-base-1:0` | true | **true** | high | actionFlipVertical.keyTest now adds !event[KEYS.CTRL_OR_CMD], onKeyDown sets IS_PLAIN_PASTE = event.shiftKey on Ctrl/Cmd+V and passes it to parseClipboard, and HelpDialog adds a pasteAsPlaintext CtrlOrCmd+Shift+V shortcut. | |
| `excalidraw-12:v2-base-1:0` | true | **true** | high | ClearCanvas now only sets activeConfirmDialogAtom to 'clearCanvas', ActiveConfirmDialog is rendered in LayerUI (outside the menu, which removes the old FIXME) and runs actionClearCanvas only in onConfirm, and MainMenu closes on item select. | |
| `excalidraw-14:v2-base-1:0` | true | **true** | high | actionToggleLinearEditor.predicate and SelectedShapeActions' showLineEditorAction now require !appState.editingLinearElement, and the new PanelComponent/label use 'labels.lineEditor.editArrow' when selectedElement.type === 'arrow'. | |
| `excalidraw-15:v2-base-1:0` | true | **true** | high | The old url.ts sanitizeHTMLAttribute only replaced double quotes; the new utils.ts version also replaces &, ', > and <, and it is still used by normalizeLink and getEmbedLink. | |
| `excalidraw-17:v2-base-1:0` | true | **true** | high | actionChangeArrowhead passes numberOfOptionsToAlwaysShow={4}, Picker puts the rest in a Collapsible whose useEffect opens it when value is not in alwaysVisibleOptions, and IconPicker drops the old options.filter(opt => opt.showInPicker !== false). | |
| `excalidraw-18:v2-base-1:0` | true | **true** | high | The new AppSidebar adds 'comments' and 'presentation' tabs, each with a 'Sign up now' LinkButton, and LayerUI's DefaultSidebar.Trigger drops the stylesPanelMode === 'full' && width >= MQ_MIN_WIDTH_DESKTOP label, leaving only the icon. | |
| `json-server-02:v2-base-1:0` | true | **true** | high | src/server/router/index.js swaps require('lowdb/adapters/FileSync') and low(new FileSync(db)) for FileAsync. | |
| `ofetch-02:v2-base-1:0` | true | **true** | high | $fetchRaw uses 'json' when parseResponse is set, otherwise opts.responseType \|\| detectResponseType(content-type); detectResponseType returns json for an empty type, text for text/* and the textTypes set, json for jsonTypes, and blob otherwise; ResponseType allows text, blob and arrayBuffer. | |
| `pathe-01:v2-base-1:0` | true | **true** | high | parse now builds root from split('/').shift() \|\| '/' and dir from the rewritten dirname, which returns '/' instead of '.' for a bare relative name, and gives root 'foo' for 'foo/bar' instead of the old path.posix.parse result. | |

## Items not in this pass (115)

- 15 cross-commit coverage items, 10 cross-commit claims and 10 inversions: false by construction. A quick skim is enough.
- 30 coverage positives (`judge-area` true): a skim is enough. If the judge says the regression's area is covered, the change is covered too.
- 50 trigger items (U2): U2 is proposed to be dropped, so they don't affect the V-3 decision. Mark them reviewed as they are, or leave them out of Run 2.
