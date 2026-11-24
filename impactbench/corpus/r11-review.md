# R-11 ground truth for review

29 large commits (more than 25 changed functions each). Each one shipped a regression that a later commit fixed. Mark each entry agree or disagree in its `review` field in `r11-large.json`.
Sorted by LLM payload size. `outside` means the entity was not in the introducer diff. `gap` means a real symbol the collector cannot see.

## r11-consola-01 (30 impacts, payload 99 KB, confidence high)
- Introducer `f4b301b9e` refactos on reporters
- Fix `66eba0f4f` fix chalkBgColor cache
- Class: plain-logic. Fix added a test: no
- Symptom: Using the same background color name a second time returned the whole cache object instead of the chalk color function, breaking colored badge output.
  - `src/utils/chalk.js#chalkBgColor` (fault)
- Areas: Background color chalk helper cache
- Evidence: Fix changes the cache-hit return from _bgColorCache to color in the function the introducer wrote; no test added.

## r11-json-server-01 (42 impacts, payload 157 KB, confidence high)
- Introducer `2b26630ac` v0.9.0 (#404)
- Fix `eca6b763f` fix filter for boolean value false (#412) (#413)
- Class: plain-logic. Fix added a test: yes
- Symptom: Filtering a collection by a boolean false value, e.g. /comments?published=false, returned nothing.
  - `src/server/router/plural.js#<module>` (fault)
- Areas: Query filtering by false values
- Evidence: Fix changes `if (!elementValue)` to `elementValue == null` so false/0 values are compared; test 'should support filtering by boolean value false' expects the three unpublished comments.

## r11-excalidraw-11 (26 impacts, payload 269 KB, confidence high)
- Introducer `8e26d5b50` feat: support vertical text align for bound containers (#4852)
- Fix `94b387ef7` fix: ensure verticalAlign properties not shown when no element selected (#4860)
- Class: plain-logic. Fix added a test: no
- Symptom: With nothing selected, the vertical-align control showed in the properties panel (all-of-empty-selection was true), and with mixed selections it was hidden.
  - `src/components/Actions.tsx#SelectedShapeActions` (fault)
- Areas: Properties panel vertical align visibility
- Evidence: Fix changes targetElements.every(...) to some(...) so changeVerticalAlign shows only when at least one selected element is bound text or a container; no test added.

## r11-excalidraw-24 (33 impacts, payload 323 KB, confidence medium)
- Introducer `b4903a7ea` feat: drag, resize, and rotate after selecting in lasso (#9732)
- Fix `90ec2739a` fix: calling toLowerCase on potentially undefined `navigator.*` values (#9901)
- Class: plain-logic. Fix added a test: no
- Symptom: The app crashed at load in environments where navigator.platform or navigator.userAgent is undefined, because the new isMobile constant called toLowerCase on them.
  - `packages/common/src/constants.ts#isMobile` (fault, gap)
- Areas: App startup device detection
- Evidence: Fix removes .toLowerCase() on navigator.userAgent and navigator.platform in isMobile (both added by the introducer); regexes are already case-insensitive. No test added.

## r11-excalidraw-05 (28 impacts, payload 365 KB, confidence high)
- Introducer `baa8fb6c1` grid support (1st iteration) (#1788)
- Fix `9c89504b6` fix: start dragging grouped elements (#1818)
- Class: plain-logic. Fix added a test: no
- Symptom: Starting to drag a grouped element moved the group with a wrong offset because the drag offset was computed before the selection included the whole group.
  - `src/components/App.tsx#App.handleCanvasPointerDown` (fault)
  - `src/element/dragElements.ts#getDragOffsetXY` (consumer)
- Areas: Dragging grouped elements
- Evidence: Fix removes the pointerDown computation of dragOffsetXY (written by the introducer) and computes it lazily on first pointerMove, after state.selectedElementIds is updated. No test added.

## r11-excalidraw-15 (32 impacts, payload 423 KB, confidence high)
- Introducer `b704705ed` feat: render footer as a component instead of render prop (#5970)
- Fix `c8370b394` fix: use displayName since name gets stripped off when uglifying/minifiyng in production (#6036)
- Class: same-signature-behavior. Fix added a test: no
- Symptom: In production (minified) builds, custom Footer children passed to Excalidraw were not recognised and the footer did not render.
  - `src/utils.ts#ReactChildrenToObject` (fault)
  - `src/components/LayerUI.tsx#LayerUI` (consumer)
- Areas: Rendering the Footer component in minified production builds
- Evidence: Fix keys the children dictionary by child.type.displayName instead of child.type.name, which uglifiers strip. The introducer wrote the .name based lookup in ReactChildrenToObject. No test added.

## r11-excalidraw-01 (40 impacts, payload 496 KB, confidence high)
- Introducer `5256096d7` Fast & Furious (#655)
- Fix `4b8b9965c` fix early return from renderScene (#815)
- Class: plain-logic. Fix added a test: no
- Symptom: Whenever any element was selected, renderScene returned early and the scrollbars were not painted.
  - `src/renderer/renderScene.ts#renderScene` (fault)
- Areas: Scrollbar rendering while elements are selected
- Evidence: Fix removes the 'return visibleElements.length > 0' that the introducer placed inside the renderSelection block, so the scrollbar painting below runs; no test added.

## r11-excalidraw-07 (32 impacts, payload 509 KB, confidence medium)
- Introducer `7eff6893c` calculate coords based on container viewport position (#1955)
- Fix `fb582b45d` fix: Fix centering element on init (#2445)
- Class: plain-logic. Fix added a test: yes
- Symptom: On init with a non-zero canvas offset the scene was not scrolled to the center of the canvas.
  - `src/components/App.tsx#App.initializeScene` (fault)
- Areas: Scroll-to-center on init; Embedding with canvas offsets
- Evidence: Fix passes this.state.width/height into calculateScrollCenter; test scroll.test.tsx asserts scrollX/scrollY center with offsets 200/100. Call was added by the introducer without width/height; blame at fix^ points to a later move, so attribution is moderate.

## r11-excalidraw-02 (34 impacts, payload 628 KB, confidence high)
- Introducer `65be7973b` Rotation support (#1099)
- Fix `4003fa24b` fix #1254 (#1255)
- Class: plain-logic. Fix added a test: no
- Symptom: At zoom other than 100% the rotation handle was drawn at the wrong distance from the selected element.
  - `src/element/handlerRectangles.ts#handlerRectangles` (fault)
- Areas: Rotation handle position when zoomed
- Evidence: Fix divides ROTATION_HANDLER_GAP by zoom (constant added by the introducer with rotation support); no test added.

## r11-excalidraw-03 (42 impacts, payload 638 KB, confidence medium)
- Introducer `61e5b66da` Group/ungroup (#1648)
- Fix `46b574283` Fix zindex in groups (#1660)
- Class: plain-logic. Fix added a test: no
- Symptom: Grouping elements put the group at the wrong z-order, so grouped shapes changed stacking relative to other elements.
  - `src/actions/actionGroup.ts#actionGroup.perform` (fault)
- Areas: Grouping elements; Layer ordering of groups
- Evidence: Fix reorders elements after grouping so the group sits at the highest member's position; the introducer's group action returned elements unordered; no test added.

## r11-excalidraw-26 (38 impacts, payload 687 KB, confidence medium)
- Introducer `d331bb49f` fix(editor): avoid overlap of flowchart children (#11532)
- Fix `a758e93d6` fix(editor): restore centered flowchart node creation (#12500)
- Class: plain-logic. Fix added a test: yes
- Symptom: Pending flowchart children were no longer centered on the parent node while Ctrl+arrow added more of them.
  - `packages/element/src/flowchart.ts#placeCluster` (fault)
  - `packages/element/src/flowchart.ts#addNewNodes` (caller)
- Areas: Flowchart node creation with Ctrl+arrow
- Evidence: Fix re-adds the parent-centered slot to the sticky candidates and narrows the obstacle zone in placeCluster; tests in packages/element/tests/flowchart.test.tsx assert centered pending positions as the cluster grows. placeCluster and the sticky logic were written by the introducer.

## r11-excalidraw-13 (30 impacts, payload 688 KB, confidence medium)
- Introducer `08ce7c7fc` feat: redesign linear elements 🎉 (#5501)
- Fix `27cf5ed17` fix: deselect linear element when clicked inside bounding box outside editor (#5579)
- Class: plain-logic. Fix added a test: no
- Symptom: Clicking inside a selected line's bounding box but off the line did not deselect it.
  - `src/components/App.tsx#App.onPointerUpFromPointerDownHandler` (fault)
  - `src/components/App.tsx#App.onPointerMoveFromPointerDownHandler` (fault)
- Areas: Deselecting a linear element by clicking inside its bounding box
- Evidence: Fix drops the !selectedLinearElement guard (written by the introducer) from the pointer-up deselect branch and sets drag.hasOccurred on drag; no test added.

## r11-excalidraw-17 (41 impacts, payload 711 KB, confidence high)
- Introducer `d4afd6626` feat: add hand/panning tool (#6141)
- Fix `68179356e` fix: Fixes the shortcut collision between "toggleHandTool" and "distributeHorizontally" (#7189)
- Class: protocol-enum. Fix added a test: no
- Symptom: Pressing Alt+Shift+H to distribute horizontally switched to the hand tool instead, because the H key test ignored modifiers.
  - `src/actions/actionCanvas.tsx#actionToggleHandTool` (fault, gap)
  - `src/actions/actionDistribute.tsx#distributeHorizontally` (caller, outside, gap)
- Areas: Keyboard shortcuts: hand tool vs distribute horizontally
- Evidence: Fix changes keyTest of toggleHandTool from event.key === H to also require no alt and no ctrl/cmd. The introducer added the unmodified H test. No test added.

## r11-excalidraw-16 (101 impacts, payload 715 KB, confidence high)
- Introducer `9f76f8677` feat: cache most of element selection (#6747)
- Fix `8101a351d` fix: resetting deleted elements on duplication (#6906)
- Class: same-signature-behavior. Fix added a test: no
- Symptom: Alt-dragging to duplicate elements dropped deleted elements from the scene, so they could not be restored by undo or sync.
  - `src/components/App.tsx#App.onPointerMoveFromPointerDownHandler` (fault)
- Areas: Alt-drag duplication of selected elements
- Evidence: Fix reverts the line the introducer changed from getElementsIncludingDeleted() back to include deleted elements when rebuilding nextElements. No test added.

## r11-excalidraw-20 (103 impacts, payload 757 KB, confidence medium)
- Introducer `550a388b2` feat: command palette (#7804)
- Fix `ed5ce8d3d` fix: command palette filter (#7981)
- Class: plain-logic. Fix added a test: no
- Symptom: Command palette search was case sensitive, so typing lowercase did not match capitalized command labels.
  - `packages/excalidraw/components/CommandPalette/CommandPalette.tsx#CommandPaletteInner` (fault)
- Areas: Command palette search
- Evidence: Fix lowercases the label haystack and the query (both written by the introducer) and moves the dash in the strip regex; no test added.

## r11-excalidraw-12 (26 impacts, payload 795 KB, confidence high)
- Introducer `d2e687ed0` feat: make file handling more robust (#5057)
- Fix `bbfd2b3cd` fix: file handle not persisted when importing excalidraw files (#5372)
- Class: same-signature-behavior. Fix added a test: no
- Symptom: After opening an .excalidraw file through the file picker, the file handle was not remembered, so Save did not write back to the opened file.
  - `src/data/json.ts#loadFromJSON` (fault)
  - `src/data/blob.ts#loadFromBlob` (consumer)
- Areas: Opening a scene file and saving back to it
- Evidence: Fix passes file.handle as the new fileHandle argument of loadFromBlob. The introducer replaced the raw picked file with normalizeFile(file), a new File that no longer carries .handle, while loadFromBlob defaults to blob.handle. No test added.

## r11-excalidraw-19 (45 impacts, payload 927 KB, confidence low)
- Introducer `015b46ab2` feat: expose `StoreAction` in relation to multiplayer history (#7898)
- Fix `4d83d1c91` fix: use Reflect API instead of Object.hasOwn (#7958)
- Class: same-signature-behavior. Fix added a test: no
- Symptom: In browsers without Object.hasOwn the store's observed-app-state check threw, breaking editor updates.
  - `packages/excalidraw/store.ts#isObservedAppState` (fault)
  - `packages/excalidraw/store.ts#getObservedAppState` (fault)
- Areas: Store/history capture on older browsers
- Evidence: Fix replaces Object.hasOwn with Reflect.get in code the introducer wrote; no test and no linked issue, so the user-visible failure is inferred from the subject.

## r11-excalidraw-14 (27 impacts, payload 931 KB, confidence high)
- Introducer `0d1058a59` feat: support segment midpoints in line editor (#5641)
- Fix `022864650` fix: line editor points rendering below elements (#5781)
- Class: plain-logic. Fix added a test: yes
- Symptom: While editing a line, its point handles were drawn under other elements overlapping it, so covered points could not be seen or dragged.
  - `src/renderer/renderScene.ts#_renderScene` (fault)
- Areas: Line editor point handles rendering; Dragging line points covered by other elements
- Evidence: Fix defers renderLinearPointHandles until after all visible elements are drawn; test 'in-editor dragging a line point covered by another element' in linearElementEditor.test.tsx drags a point under a rectangle.

## r11-excalidraw-04 (54 impacts, payload 949 KB, confidence medium)
- Introducer `14a66956d` Implement line editing (#1616)
- Fix `476c0e9f8` Fix undo with line editing (#1717)
- Class: plain-logic. Fix added a test: no
- Symptom: Undo after line editing did not step back correctly because history recording was not resumed when finishing a point.
  - `src/element/linearElementEditor.ts#LinearElementEditor.handlePointerUp` (fault)
- Areas: Undo while editing a line
- Evidence: Fix makes history.resumeRecording() unconditional, removing the lastUncommittedPoint !== null guard the introducer wrote; no test added.

## r11-excalidraw-10 (61 impacts, payload 1188 KB, confidence high)
- Introducer `f47ddb988` feat: Support hyperlinks 🔥  (#4620)
- Fix `de6371aac` fix: link popup position not accounting for offsets (#4695)
- Class: plain-logic. Fix added a test: no
- Symptom: The hyperlink popup appeared shifted by the editor offset when the canvas was not at the page origin.
  - `src/element/Hyperlink.tsx#getCoordsForPopover` (fault)
  - `src/element/Hyperlink.tsx#Hyperlink` (caller)
- Areas: Link popup position over linked elements
- Evidence: Fix subtracts appState.offsetLeft/offsetTop in getCoordsForPopover, which the introducer wrote without offsets. No test added.

## r11-excalidraw-25 (110 impacts, payload 1397 KB, confidence medium)
- Introducer `a0b98a944` feat: TextToDiagram v2 (#10530)
- Fix `613554853` fix: rerender TTD preview on message remove (#10681)
- Class: plain-logic. Fix added a test: no
- Symptom: In the text-to-diagram dialog the diagram preview did not re-render after a chat message was removed.
  - `packages/excalidraw/components/TTDDialog/hooks/useMermaidRenderer.ts#useMermaidRenderer` (fault)
- Areas: TTD preview refresh on message removal
- Evidence: Fix merges the two effects so a non-generating state flushes and re-renders the last assistant message when content changes; no test added.

## r11-excalidraw-18 (120 impacts, payload 1544 KB, confidence high)
- Introducer `e9cae918a` feat: sidebar tabs support (#6213)
- Fix `65bc50059` fix: `excalidrawAPI.toggleSidebar` not switching between tabs correctly (#7821)
- Class: plain-logic. Fix added a test: yes
- Symptom: excalidrawAPI.toggleSidebar did not switch between tabs of an open sidebar; it closed the sidebar instead.
  - `src/components/App.tsx#App.toggleSidebar` (fault)
- Areas: Sidebar tabs toggled through the imperative API
- Evidence: Fix compares tab as well as name when deciding to close, and accepts name null; test added in Sidebar.test.tsx switches library to comments tab. The toggling logic was written by the introducer.

## r11-excalidraw-23 (54 impacts, payload 1697 KB, confidence high)
- Introducer `ce267aa0d` feat: lasso selection (#9169)
- Fix `a18b139a6` fix: laser pointer trail disappearing on pointerup (#9413) (#9427)
- Class: plain-logic. Fix added a test: no
- Symptom: The laser pointer trail vanished immediately on pointerup instead of fading out.
  - `packages/excalidraw/animated-trail.ts#AnimatedTrail.update` (fault)
- Areas: Laser pointer trail
- Evidence: Fix removes the this.pastTrails = [] reset that the lasso introducer added to update(); no test added.

## r11-excalidraw-06 (126 impacts, payload 1950 KB, confidence high)
- Introducer `e617ccc25` Factor out collaboration code (#2313)
- Fix `98c26642d` fix: hide collab button when onCollabButtonClick not supplied (#2598)
- Class: default-option. Fix added a test: no
- Symptom: The collab button was always shown, even when the host app supplied no onCollabButtonClick handler.
  - `src/packages/excalidraw/index.tsx#Excalidraw` (fault)
- Areas: Collab button visibility in the embedded package
- Evidence: Fix removes the onCollabButtonClick = noop default (added by the introducer) so the button is hidden when unsupplied; no test added.

## r11-excalidraw-27 (67 impacts, payload 2003 KB, confidence high)
- Introducer `d2557474e` fix(editor): fix target element index when creating/adding elements to frames (#11257)
- Fix `8bcdca452` fix(editor): ignore deleted elements when inserting frame children (#12510)
- Class: plain-logic. Fix added a test: yes
- Symptom: After deleting a frame child that sat above the frame, new children of that frame were inserted above the frame, up to the top of the canvas.
  - `packages/element/src/frame.ts#getFrameChildrenInsertionIndex` (fault)
- Areas: Adding elements to frames; Layer ordering of frame children
- Evidence: Fix skips deleted children in getFrameChildrenInsertionIndex (written by the introducer); test in frame.test.tsx expects the new child below the frame despite a deleted child above.

## r11-excalidraw-09 (89 impacts, payload 2625 KB, confidence medium)
- Introducer `98b5c37e4` feat: bind text to shapes when pressing enter and support sticky notes 🎉  (#4343)
- Fix `28546fbb5` fix: bound text doesn't inherit container (#4521)
- Class: plain-logic. Fix added a test: no
- Symptom: A text element bound to a container inside a group was not part of that group.
  - `src/components/App.tsx#App.startTextEditing` (fault)
- Areas: Bound text group membership
- Evidence: Fix adds groupIds: container?.groupIds ?? [] next to the containerId the introducer set when creating bound text; no test added.

## r11-excalidraw-21 (280 impacts, payload 3947 KB, confidence medium)
- Introducer `530617be9` feat: multiplayer undo / redo (#7348)
- Fix `afe52c89a` fix: undo/redo when exiting view mode (#8024)
- Class: plain-logic. Fix added a test: yes
- Symptom: After exiting view mode the undo and redo buttons showed the wrong enabled state until the history changed.
  - `packages/excalidraw/actions/actionHistory.tsx#createUndoAction` (fault)
  - `packages/excalidraw/actions/actionHistory.tsx#createRedoAction` (fault)
- Areas: Undo and redo buttons after view mode toggles
- Evidence: Fix seeds useEmitter with the current history.isUndoStackEmpty/isRedoStackEmpty instead of an empty HistoryChangedEvent; test in history.test.tsx asserts button disabled states. The empty initial event was written by the introducer.

## r11-excalidraw-08 (210 impacts, payload 7012 KB, confidence high)
- Introducer `26f67d27e` Allow binding linear elements to other elements (#1899)
- Fix `969d3c694` fix: keep binding for attached arrows after changing text (#3754)
- Class: plain-logic. Fix added a test: yes
- Symptom: Editing the text of an element that an arrow was bound to removed the arrow binding.
  - `src/components/App.tsx#App.handleTextWysiwyg` (fault)
  - `src/element/binding.ts#fixBindingsAfterDeletion` (consumer)
- Areas: Arrows bound to text elements; Editing bound text
- Evidence: Fix calls fixBindingsAfterDeletion only when the text was deleted (isDeleted) instead of in the else of the selection branch; binding.test.tsx adds should keep binding on text update. The else branch was written by the introducer.

## r11-excalidraw-22 (214 impacts, payload 13126 KB, confidence high)
- Introducer `15e019706` feat: Orthogonal (elbow) arrows for diagramming (#8299)
- Fix `84398a7e5` fix: Point duplication in LEE on ALT+click (#8347)
- Class: plain-logic. Fix added a test: no
- Symptom: Alt+click in the linear element editor duplicated a point on elbow arrows.
  - `packages/excalidraw/element/linearElementEditor.ts#LinearElementEditor.handlePointerDown` (fault)
- Areas: Alt+click point add in the line editor; Elbow arrows
- Evidence: Fix changes || to && in the lastUncommittedPoint/isElbowArrow condition the introducer wrote; no test added.

## Rejected candidates

- excalidraw `cd50aa719` → `8a162a4cb` fix: import (#7869): SZZ blame wrong: fix only adds a missing CODES import; at fix^ the file already used CODES.D, while the introducer's version used KEYS.D, so a later commit introduced the break.
- excalidraw `e1b7aacb3` → `95307fa13` fix(packages/excalidraw): export PNGs from a CPU-backed canvas (#12471): Not caused by introducer: fix works around Chrome's Skia Graphite GPU canvas antialiasing; the canvas creation path is environmental/browser behavior, not logic the introducer changed. Cosmetic quality issue.
- excalidraw `b57b3b573` → `1f94f204d` fix: isBindableElement to affirm frames (#6900): SZZ blame wrong: omission of 'frame' in isBindableElement belongs to the frames feature (81ebf829 introduced frame); web-embeds only added an adjacent 'embeddable' line.
- excalidraw `81ebf8297` → `eb020d041` fix: generic element's labels not flipping with them (#6967): SZZ blame wrong: bound text was not included in multi-element flip since multi-flip was added (6459ccda); frames only added the includeElementsInFrames option beside it. Bug not caused by frames.
- consola `661752c3a` → `ff24b696f` fix: remove file:// from error stack traces: The introducer only moved parseStack from utils/index.js to utils/error.js unchanged; file:// prefixes in ESM stack traces were never handled. The fix adds handling for a case that was always missing, so not a regression.
- json-server `25b2e4364` → `e660f0bd6` Fix empty string conversion: toNative with the isNaN(+value) check existed before "Use restify" and was only moved (old utils/utils.js had the same line); empty strings were always converted to 0. SZZ blame is wrong.
- excalidraw `437595fa6` → `47c254216` fix(editor): disable snap-to-midpoint menu item when arrow-binding disabled (#10885): Fix only greys out the midpoint snapping menu item when binding is disabled (DefaultItems.tsx plus scss). It is a UI polish with no wrong data or functional regression and no test.
- excalidraw `0e5c29b3f` → `e27f3f9ad` fix(data): removes unnecessary await (#1549): Fix only drops an unnecessary async/await in getImportedKey; no behavior was broken by the introducer.
- excalidraw `675da16ca` → `cf6a5ff16` fix: state continuously updated when holding ctrl/cmd (#3283): Fix guards a redundant setState; the introducer only moved the pre-existing 'if (event[CTRL_OR_CMD]) setState({isBindingEnabled:false})' lines, so the repeated update predates it (blame is a move).
