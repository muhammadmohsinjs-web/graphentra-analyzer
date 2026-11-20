# V-13e plain checks: side by side (data-v4, 33 reports with gaps)

## consola-02 run 1 (3 gaps)

**Before (code names):**

- createConsola in src/consola.ts
- <module> in src/log.types.ts
- createConsola in src/consola.node.ts

**After:**

- Verify that calling the package’s logger factory with options returns a new logger that uses those options.
- Check that the logging types module exposes its types through the named Types export.
- Confirm that loading the Node entry point creates or reuses a global logger and returns that same logger as the default export.

_For a developer:_
- createConsola in src/consola.ts
- <module> in src/log.types.ts
- createConsola in src/consola.node.ts

## consola-02 run 2 (6 gaps)

**Before (code names):**

- createConsola in src/consola.ts
- <module> in src/index.shared.ts
- <module> in src/log.types.ts
- createConsola in src/consola.browser.ts
- src/consola.node.ts: 2 changes (<module>, createConsola)

**After:**

- Verify the exported factory creates a usable logger that can perform a logging operation.
- Check that consumers can import the exported log types, log levels, log-object check, and global-logger assignment helper.
- Confirm consumers can import the log types as a named export from the shared entry point.
- Check that importing the Node entry point without an existing global logger does not automatically create a global logger.

_For a developer:_
- createConsola in src/consola.ts
- <module> in src/index.shared.ts
- <module> in src/log.types.ts
- createConsola in src/consola.browser.ts
- src/consola.node.ts: 2 changes (<module>, createConsola)

## consola-02 run 3 (9 gaps)

**Before (code names):**

- createConsola in src/consola.ts
- _createConsola in src/index.browser.ts
- src/index.ts: 2 changes (_createConsola, _getDefaultLogLevel)
- <module> in src/log.types.ts
- src/consola.browser.ts: 2 changes (<module>, createConsola)
- src/consola.node.ts: 2 changes (<module>, createConsola)

**After:**

- Verify that creating a logger with a reporter that records messages and then logging a message sends it to that reporter.
- Check that the browser package entry creates a logger whose messages appear through the browser console reporter.
- Confirm that the Node package entry uses the debug, test, and info default log levels in their respective environments, honors a valid log-level environment override, and selects the basic reporter in CI or test environments.
- Verify that the package exposes Types as a named export that a consumer can import.
- Check that the former browser-specific entry no longer provides its default logger export.
- Check that the former Node-specific entry no longer provides its default logger export or initializes a global logger.

_For a developer:_
- createConsola in src/consola.ts
- _createConsola in src/index.browser.ts
- src/index.ts: 2 changes (_createConsola, _getDefaultLogLevel)
- <module> in src/log.types.ts
- src/consola.browser.ts: 2 changes (<module>, createConsola)
- src/consola.node.ts: 2 changes (<module>, createConsola)

## consola-03 run 1 (31 gaps)

**Before (code names):**

- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 3 changes (<module>, createConsola, _createConsola)
- <module> in src/types.ts
- src/utils/prompt.ts: 22 changes (s, symbol, text, password, confirm, select, selectKey, strip, note, cancel, intro, outro, log.message, log.info, log.success, log.step, log.warn, log.warning, log.error, spinner, ansiRegex, group)

**After:**

- Verify a consola created with a custom prompt option uses that prompt when a caller starts a prompt; expect the supplied prompt’s result.
- Check the public package entry point lets a caller create a consola with custom reporters, and that its default reporter behaves as expected in the running environment.
- Test text and password prompts in a terminal: enter a value for each and confirm it is returned, with password characters masked while typing.
- Verify the string-choice prompt displays its options, accepts a choice, and returns the chosen value.
- Check a prompt group runs its prompts in order, makes earlier results available to later prompts, and returns the collected results.
- Verify the note helper displays its title and message without visible terminal color-control characters, and that the intro, outro, and cancel helpers print their supplied text.
- Check the prompt logging helpers display supplied messages with their corresponding information, success, step, warning, or error indicators, and verify the spinner starts with a message and stops when requested.

_For a developer:_
- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 3 changes (<module>, createConsola, _createConsola)
- <module> in src/types.ts
- src/utils/prompt.ts: 22 changes (s, symbol, text, password, confirm, select, selectKey, strip, note, cancel, intro, outro, log.message, log.info, log.success, log.step, log.warn, log.warning, log.error, spinner, ansiRegex, group)

## consola-03 run 2 (30 gaps)

**Before (code names):**

- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 3 changes (<module>, createConsola, _createConsola)
- <module> in src/types.ts
- src/utils/prompt.ts: 21 changes (<module>, s, symbol, password, confirm, groupMultiselect, strip, note, cancel, intro, outro, log.message, log.info, log.success, log.step, log.warn, log.warning, log.error, spinner, ansiRegex, group)

**After:**

- Check that a prompt function supplied when creating a logging instance is used when that instance receives a prompt request.
- Verify that the main library entry can create a logging instance with supplied reporters and that its default output appears in the appropriate terminal environment.
- Confirm that the browser library entry creates a logging instance with browser-style logging output.
- Check that consumers can create logging instances through the shared library entry and verify whether that entry still exposes the instance-creation API.
- Test a password request by entering a value and confirm that the displayed input is masked.
- Verify that grouped prompts run in order and that later prompts can use results from earlier prompts.
- Check that the terminal prompt utilities display their titles, notes, messages, and status symbols, and that the spinner starts and stops with its message.

_For a developer:_
- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 3 changes (<module>, createConsola, _createConsola)
- <module> in src/types.ts
- src/utils/prompt.ts: 21 changes (<module>, s, symbol, password, confirm, groupMultiselect, strip, note, cancel, intro, outro, log.message, log.info, log.success, log.step, log.warn, log.warning, log.error, spinner, ansiRegex, group)

## consola-03 run 3 (28 gaps)

**Before (code names):**

- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 2 changes (<module>, _createConsola)
- src/utils/prompt.ts: 21 changes (<module>, s, symbol, password, selectKey, groupMultiselect, strip, note, cancel, intro, outro, log.message, log.info, log.success, log.step, log.warn, log.warning, log.error, spinner, ansiRegex, group)

**After:**

- Verify that creating a console with prompt support enabled lets you run a password, single-choice, multiple-choice, and grouped prompt in the terminal, and that submitted answers are returned.
- Check terminal prompt displays as it changes from active to submitted, cancelled, or invalid, and confirm its symbols remain readable in the terminal.
- Confirm a note containing colored text is displayed with its title and message aligned correctly, without counting color codes as visible characters.
- Verify the terminal can display an intro and outro, report a cancellation, show messages at the available severity levels, and start and stop an animated spinner.
- Check that the default console still logs through the appropriate terminal or browser output, and that the shared library entry no longer exposes the console factory.

_For a developer:_
- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 2 changes (<module>, _createConsola)
- src/utils/prompt.ts: 21 changes (<module>, s, symbol, password, selectKey, groupMultiselect, strip, note, cancel, intro, outro, log.message, log.info, log.success, log.step, log.warn, log.warning, log.error, spinner, ansiRegex, group)

## excalidraw-01 run 1 (17 gaps)

**Before (code names):**

- src/history.ts: 2 changes (SceneHistory.restoreEntry, SceneHistory.undoOnce)
- src/index.tsx: 9 changes (App.componentDidMount, App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeOpacity, App.changeBackgroundColor, App.redrawTextBoundingBox)
- createScene in src/scene/createScene.ts
- setSelection in src/scene/selection.ts
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

**After:**

- Verify that copying a styled text element and pasting its style onto another element applies the copied appearance and updates the pasted text’s visible bounds.
- Check that after saving a scene and reloading the application, the saved elements and application state are restored.
- Test moving a selected element backward and forward in the drawing order, and moving all selected elements to the back and front; verify that their visible overlap order changes accordingly.

_For a developer:_
- src/history.ts: 2 changes (SceneHistory.restoreEntry, SceneHistory.undoOnce)
- src/index.tsx: 9 changes (App.componentDidMount, App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeOpacity, App.changeBackgroundColor, App.redrawTextBoundingBox)
- createScene in src/scene/createScene.ts
- setSelection in src/scene/selection.ts
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

## excalidraw-01 run 2 (24 gaps)

**Before (code names):**

- src/history.ts: 3 changes (SceneHistory.restoreEntry, SceneHistory.redoOnce, SceneHistory.undoOnce)
- src/index.tsx: 13 changes (App.componentDidMount, App.onKeyDown, App.deleteSelectedElements, App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeProperty, App.changeOpacity, App.changeStrokeColor, App.changeBackgroundColor, App.redrawTextBoundingBox)
- createScene in src/scene/createScene.ts
- src/scene/selection.ts: 3 changes (setSelection, clearSelection, deleteSelectedElements)
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

**After:**

- Verify that undoing and redoing drawing changes restores the expected earlier and later drawings, and that using these shortcuts leaves the canvas in the correct state.
- Check that after saving a drawing and reloading the editor, the saved elements and application state are restored.
- Confirm that deleting selected elements removes them from the canvas, and that changing background color, opacity, or stroke color updates the selected elements as expected.
- Test copying and pasting styles onto text and other elements, and confirm the pasted styles are visible, including the text’s updated appearance.
- Ensure that moving selected elements forward or backward by one step or to the front or back changes their visible stacking order as expected.

_For a developer:_
- src/history.ts: 3 changes (SceneHistory.restoreEntry, SceneHistory.redoOnce, SceneHistory.undoOnce)
- src/index.tsx: 13 changes (App.componentDidMount, App.onKeyDown, App.deleteSelectedElements, App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeProperty, App.changeOpacity, App.changeStrokeColor, App.changeBackgroundColor, App.redrawTextBoundingBox)
- createScene in src/scene/createScene.ts
- src/scene/selection.ts: 3 changes (setSelection, clearSelection, deleteSelectedElements)
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

## excalidraw-01 run 3 (16 gaps)

**Before (code names):**

- src/index.tsx: 10 changes (App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeProperty, App.changeOpacity, App.changeStrokeColor, App.changeBackgroundColor, App.redrawTextBoundingBox)
- src/scene/selection.ts: 2 changes (setSelection, deleteSelectedElements)
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

**After:**

- Verify copying and pasting styles onto shapes and text updates their visible colors, fill, opacity, stroke width, roughness, and font, with pasted text fitting its updated font.
- Check that moving selected objects one step or all the way forward and backward changes their stacking order as expected, with the objects still visible and selectable.
- Verify changing selected objects’ background color, opacity, and stroke color updates their appearance, then delete selected objects and confirm they disappear while unselected objects remain.

_For a developer:_
- src/index.tsx: 10 changes (App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeProperty, App.changeOpacity, App.changeStrokeColor, App.changeBackgroundColor, App.redrawTextBoundingBox)
- src/scene/selection.ts: 2 changes (setSelection, deleteSelectedElements)
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

## excalidraw-02 run 1 (10 gaps)

**Before (code names):**

- src/actions/actionProperties.tsx: 5 changes (actionChangeStrokeColor.PanelComponent, actionChangeBackgroundColor.PanelComponent, actionChangeStrokeWidth.PanelComponent, actionChangeSloppiness.PanelComponent, actionChangeFontFamily.PanelComponent)
- ColorPicker in src/components/ColorPicker.tsx
- <module> in src/element/index.ts
- newTextElement in src/element/newElement.ts
- <module> in src/scene/index.ts
- getCommonAttributeOfSelectedElements in src/scene/selection.ts

**After:**

- Verify that while editing an element, the stroke color, background color, stroke width, roughness, and font controls show that element’s values rather than the different values of another selected element.
- Check that when selected elements share a background color or fill style, the corresponding controls show that shared value.
- Confirm that a library caller can access the newly exported text-element creation capability and that the resulting text is centered on the source element’s position and sized to fit the text.
- Validate that library callers can access the shared selected-element attribute capability through the public element-scene interface.

_For a developer:_
- src/actions/actionProperties.tsx: 5 changes (actionChangeStrokeColor.PanelComponent, actionChangeBackgroundColor.PanelComponent, actionChangeStrokeWidth.PanelComponent, actionChangeSloppiness.PanelComponent, actionChangeFontFamily.PanelComponent)
- ColorPicker in src/components/ColorPicker.tsx
- <module> in src/element/index.ts
- newTextElement in src/element/newElement.ts
- <module> in src/scene/index.ts
- getCommonAttributeOfSelectedElements in src/scene/selection.ts

## excalidraw-02 run 2 (2 gaps)

**Before (code names):**

- actionChangeSloppiness.PanelComponent in src/actions/actionProperties.tsx
- addTextElement in src/index.tsx

**After:**

- Verify that while editing one element with another element selected, the roughness control shows the edited element’s roughness value.
- Check that changing the text and font of an existing text element and submitting updates the text and recalculates its dimensions and placement to match the submitted text.

_For a developer:_
- actionChangeSloppiness.PanelComponent in src/actions/actionProperties.tsx
- addTextElement in src/index.tsx

## excalidraw-02 run 3 (1 gaps)

**Before (code names):**

- addTextElement in src/index.tsx

**After:**

- Verify that text created with a chosen font appears in that font and is sized to fit the entered text.

_For a developer:_
- addTextElement in src/index.tsx

## excalidraw-03 run 1 (4 gaps)

**Before (code names):**

- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx
- LockIcon in src/components/LockIcon.tsx

**After:**

- Confirm that a fresh editor session starts with zen mode off.
- Verify that a supplied extra styling class appears on fixed side containers.
- Check that the lock control is hidden while zen mode is on and visible again when zen mode is off.

_For a developer:_
- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx
- LockIcon in src/components/LockIcon.tsx

## excalidraw-03 run 2 (3 gaps)

**Before (code names):**

- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

**After:**

- Verify that clearing the canvas or opening a board from a file leaves the editor in normal mode, with the zen-mode exit control absent.
- Check that fixed side containers display the additional styling supplied by their callers.

_For a developer:_
- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

## excalidraw-03 run 3 (3 gaps)

**Before (code names):**

- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

**After:**

- Verify that opening a fresh drawing or clearing the canvas leaves Zen mode off and the editor controls visible.
- Check that supplying an additional class to a fixed side container adds that class to its rendered element while preserving its side styling.

_For a developer:_
- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

## excalidraw-05 run 1 (6 gaps)

**Before (code names):**

- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- src/appState.ts: 2 changes (<module>, getDefaultAppState)
- getTotalStorageSize in src/excalidraw-app/data/localStorage.ts
- src/utils.ts: 2 changes (debounce, nFormatter)

**After:**

- Verify that clearing the drawing while the statistics panel is open leaves the panel open, and resetting the scene closes it.
- Check that the statistics panel’s open state is retained by browser storage but is not carried into an exported drawing.
- Confirm that changing the drawing’s elements updates the displayed total storage size to include their storage, using abbreviated units for large sizes.
- Test that resetting the scene cancels a pending save so that the previous drawing does not reappear after reloading.

_For a developer:_
- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- src/appState.ts: 2 changes (<module>, getDefaultAppState)
- getTotalStorageSize in src/excalidraw-app/data/localStorage.ts
- src/utils.ts: 2 changes (debounce, nFormatter)

## excalidraw-05 run 2 (6 gaps)

**Before (code names):**

- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- getDefaultAppState in src/appState.ts
- src/excalidraw-app/data/localStorage.ts: 2 changes (getElementsStorageSize, getTotalStorageSize)
- src/utils.ts: 2 changes (debounce, nFormatter)

**After:**

- Verify the statistics panel is closed on a fresh scene, remains open when the canvas is cleared while it is open, and closes after resetting the scene.
- Check that adding or removing drawing elements changes the displayed total storage size to reflect the elements stored.
- Confirm that sufficiently large storage sizes are displayed with compact unit suffixes such as k, M, or G.

_For a developer:_
- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- getDefaultAppState in src/appState.ts
- src/excalidraw-app/data/localStorage.ts: 2 changes (getElementsStorageSize, getTotalStorageSize)
- src/utils.ts: 2 changes (debounce, nFormatter)

## excalidraw-05 run 3 (5 gaps)

**Before (code names):**

- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- getDefaultAppState in src/appState.ts
- getStorageSizes in src/components/Stats.tsx
- src/utils.ts: 2 changes (debounce, nFormatter)

**After:**

- Verify that clearing the canvas while the Stats panel is open leaves the panel open.
- Check that the Stats panel is closed on a fresh editor and remains closed after resetting the scene.
- Test that after changing the drawing and waiting for the storage-size display to update, the displayed scene storage size reflects the changed drawing.
- Check that storage-size values use abbreviated units such as b, k, M, or G, without unnecessary trailing decimal zeros when applicable.

_For a developer:_
- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- getDefaultAppState in src/appState.ts
- getStorageSizes in src/components/Stats.tsx
- src/utils.ts: 2 changes (debounce, nFormatter)

## excalidraw-10 run 1 (2 gaps)

**Before (code names):**

- App.updateScene in src/components/App.tsx
- <module> in src/packages/excalidraw/example/App.js

**After:**

- Verify that passing library items through a scene update does not change the editor’s library.

_For a developer:_
- App.updateScene in src/components/App.tsx
- <module> in src/packages/excalidraw/example/App.js

## excalidraw-10 run 2 (2 gaps)

**Before (code names):**

- App.updateScene in src/components/App.tsx
- App.importLibraryFromUrl in src/components/App.tsx

**After:**

- Verify updating the scene with supplied library items leaves the existing library unchanged.
- Check that opening a library-sharing URL with a token that does not match the editor does not show a confirmation prompt to add the items.

_For a developer:_
- App.updateScene in src/components/App.tsx
- App.importLibraryFromUrl in src/components/App.tsx

## excalidraw-10 run 3 (4 gaps)

**Before (code names):**

- src/components/App.tsx: 2 changes (App.updateScene, App.importLibraryFromUrl)
- parseLibraryTokensFromUrl in src/data/library.ts
- <module> in src/packages/excalidraw/index.tsx

**After:**

- Check that updating a scene with supplied library items does not change the library contents.
- Verify that opening a shared-library link in the URL hash with a matching token imports its items, opens the Library without asking for confirmation, and removes the link parameter from the URL.
- Confirm that integrations using the embedded editor package can access its exported library URL parsing and handling utilities.

_For a developer:_
- src/components/App.tsx: 2 changes (App.updateScene, App.importLibraryFromUrl)
- parseLibraryTokensFromUrl in src/data/library.ts
- <module> in src/packages/excalidraw/index.tsx

## excalidraw-12 run 1 (2 gaps)

**Before (code names):**

- <module> in src/components/dropdownMenu/common.ts
- getDrodownMenuItemClassName in src/components/dropdownMenu/common.ts

**After:**

- Verify menu items and menu-item links display with consistent menu-item styling.

_For a developer:_
- <module> in src/components/dropdownMenu/common.ts
- getDrodownMenuItemClassName in src/components/dropdownMenu/common.ts

## excalidraw-12 run 2 (5 gaps)

**Before (code names):**

- LayerUI in src/components/LayerUI.tsx
- DropdownMenuItemLink in src/components/dropdownMenu/DropdownMenuItemLink.tsx
- src/components/dropdownMenu/common.ts: 2 changes (<module>, getDrodownMenuItemClassName)
- <module> in src/constants.ts

**After:**

- Verify that selecting a social link from the editor menu closes the menu.

_For a developer:_
- LayerUI in src/components/LayerUI.tsx
- DropdownMenuItemLink in src/components/dropdownMenu/DropdownMenuItemLink.tsx
- src/components/dropdownMenu/common.ts: 2 changes (<module>, getDrodownMenuItemClassName)
- <module> in src/constants.ts

## excalidraw-12 run 3 (3 gaps)

**Before (code names):**

- LayerUI in src/components/LayerUI.tsx
- <module> in src/components/dropdownMenu/common.ts
- getDrodownMenuItemClassName in src/components/dropdownMenu/common.ts

**After:**

- Verify that preventing the default action in a Library item’s click handler also prevents the menu from closing.

_For a developer:_
- LayerUI in src/components/LayerUI.tsx
- <module> in src/components/dropdownMenu/common.ts
- getDrodownMenuItemClassName in src/components/dropdownMenu/common.ts

## pathe-01 run 1 (1 gaps)

**Before (code names):**

- relative in src/path.ts

**After:**

- Verify that requesting the relative path from "a" to "a/b" returns "b".

_For a developer:_
- relative in src/path.ts

## pathe-01 run 2 (2 gaps)

**Before (code names):**

- relative in src/path.ts
- format in src/path.ts

**After:**

- Verify that requesting the relative path from “folder/one” to “folder/two” returns “../two”.
- Check that formatting components with root “/”, directory “/folder”, and base “file.txt” returns “/folder/file.txt”.

_For a developer:_
- relative in src/path.ts
- format in src/path.ts

## pathe-01 run 3 (2 gaps)

**Before (code names):**

- relative in src/path.ts
- dirname in src/path.ts

**After:**

- Verify calculating the relative path from “/a/b” to “/a/c” returns “../c”.
- Check that the directory of a relative single-segment path such as “file” is “/”.

_For a developer:_
- relative in src/path.ts
- dirname in src/path.ts

## ufo-01 run 1 (29 gaps)

**Before (code names):**

- src/encoding.ts: 2 changes (encodeHash, decode)
- src/index.ts: 7 changes (<module>, getParams, joinPath, joinURL, normalizeURL, parseURL, withParams)
- hasProtocol in src/parse.ts
- src/ufo.ts: 11 changes (UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get fullpath, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 8 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, normalizeURL, withParams, joinURL)

**After:**

- Verify callers can access the URL utilities through the package and serialize a URL with a protocol, credentials, host, port, path, query, and hash; confirm the resulting string includes the URL parts and context-appropriate encoding.
- Check parsing a URL with percent-encoded text and malformed percent escapes; confirm valid escapes are decoded and malformed escapes remain unchanged.
- Test URLs with and without a scheme followed by ://; confirm the parser identifies only the former as having a protocol, and that absolute status reflects a protocol or a leading slash.
- Validate joining relative URL parts with and without leading or trailing slashes; confirm the joined path has a single separator between parts, parameters are merged, a later hash is used, and joining a URL with a protocol is rejected.
- Check the exported URL helpers by normalizing a URL, adding parameters to it, and joining URL paths; confirm normalization returns a serialized URL, added parameters appear in the result, and joining combines the supplied paths.

_For a developer:_
- src/encoding.ts: 2 changes (encodeHash, decode)
- src/index.ts: 7 changes (<module>, getParams, joinPath, joinURL, normalizeURL, parseURL, withParams)
- hasProtocol in src/parse.ts
- src/ufo.ts: 11 changes (UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get fullpath, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 8 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, normalizeURL, withParams, joinURL)

## ufo-01 run 2 (36 gaps)

**Before (code names):**

- src/encoding.ts: 8 changes (<module>, encode, encodeHash, encodeQueryValue, encodeQueryKey, encodePath, encodeParam, decode)
- src/index.ts: 5 changes (<module>, getParams, joinPath, joinURL, withParams)
- src/parse.ts: 2 changes (parseURLNative, hasProtocol)
- src/ufo.ts: 12 changes (<module>, UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get fullpath, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 9 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, createURL, withParams, getParams, joinURL)

**After:**

- Verify URL output encodes special characters appropriately in paths, parameters, query keys and values, and hashes, while decoding valid escapes and leaving malformed escapes unchanged.
- Check that parsing distinguishes URLs with a protocol from relative URLs, and that a parsed URL exposes the expected protocol, absolute status, host, origin, authenticated origin, authentication, full path, href and string or JSON representation.
- Verify the exported slash helpers add or remove a leading or trailing slash as appropriate, and that double slashes are cleaned without changing the protocol separator.
- Check that joining relative URL parts appends their paths, parameters and hash to the base, and rejects a part that has a protocol.
- Verify the exported URL helpers create and read URLs, and that adding parameters preserves existing parameters while applying supplied values; confirm the package exposes its utility, parsing, URL and encoding APIs.

_For a developer:_
- src/encoding.ts: 8 changes (<module>, encode, encodeHash, encodeQueryValue, encodeQueryKey, encodePath, encodeParam, decode)
- src/index.ts: 5 changes (<module>, getParams, joinPath, joinURL, withParams)
- src/parse.ts: 2 changes (parseURLNative, hasProtocol)
- src/ufo.ts: 12 changes (<module>, UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get fullpath, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 9 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, createURL, withParams, getParams, joinURL)

## ufo-01 run 3 (26 gaps)

**Before (code names):**

- encodeHash in src/encoding.ts
- hasProtocol in src/parse.ts
- src/ufo.ts: 11 changes (<module>, UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 8 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, normalizeURL, withParams, joinURL)
- src/index.ts: 5 changes (getParams, joinPath, joinURL, normalizeURL, withParams)

**After:**

- Verify a URL containing a hash with curly braces and a caret serializes with those characters preserved in the hash.
- Check that a URL with a protocol is recognized as absolute, while a path beginning with a slash and no protocol is also treated as absolute.
- Confirm a URL with a hostname, port, username, and password produces an encoded host and credentials in its origin, and that its serialized URL includes that origin and its path.
- Test joining a base URL with a relative URL adds its path, query parameters, and hash, rejects a URL that has a protocol, and produces the expected joined path when path segments have leading or trailing slashes.
- Validate that URL string and JSON serialization return the URL text, URL normalization produces normalized URL text, and adding parameters preserves existing parameters while applying the supplied values.

_For a developer:_
- encodeHash in src/encoding.ts
- hasProtocol in src/parse.ts
- src/ufo.ts: 11 changes (<module>, UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 8 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, normalizeURL, withParams, joinURL)
- src/index.ts: 5 changes (getParams, joinPath, joinURL, normalizeURL, withParams)

## ufo-02 run 1 (30 gaps)

**Before (code names):**

- <module> in src/index.ts
- src/parse.ts: 4 changes (parseAuth, parseHost, parseParams, parsedParamsToObject)
- src/url.ts: 11 changes ($URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get hasProtocol, $URL.get origin, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON, $URL.toString)
- src/utils.ts: 3 changes (createURL, getParams, withParams)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 10 changes (<module>, UFO.append, UFO.get auth, UFO.get host, UFO.get href, UFO.get origin, UFO.get originWithAuth, UFO.get searchParams, UFO.toJSON, UFO.toString)

**After:**

- Verify that the public entry point makes the new URL and query capabilities available to callers and no longer exposes the removed URL class.
- Check that a URL with encoded username and password exposes the decoded credentials, and that its encoded-auth value safely re-encodes them.
- Verify that a URL with a host and port exposes its hostname, port, and encoded host as observable host and origin values.
- Confirm that protocol presence is reflected in the protocol indicator and that converting a URL to text or JSON returns its expected href, including credentials when present.
- Test resolving a relative URL onto a base URL: its path, query, and fragment are combined, while appending a URL that has a protocol produces an error.
- Check that serializing query values preserves repeated values and that the available URL query-reading and URL-building capabilities can be used by callers.

_For a developer:_
- <module> in src/index.ts
- src/parse.ts: 4 changes (parseAuth, parseHost, parseParams, parsedParamsToObject)
- src/url.ts: 11 changes ($URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get hasProtocol, $URL.get origin, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON, $URL.toString)
- src/utils.ts: 3 changes (createURL, getParams, withParams)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 10 changes (<module>, UFO.append, UFO.get auth, UFO.get host, UFO.get href, UFO.get origin, UFO.get originWithAuth, UFO.get searchParams, UFO.toJSON, UFO.toString)

## ufo-02 run 2 (39 gaps)

**Before (code names):**

- src/parse.ts: 5 changes (parsePath, parseAuth, parseHost, stringifyParsedURL, parsedParamsToObject)
- src/query.ts: 2 changes (encodeQueryItem, stringifyQuery)
- src/url.ts: 15 changes (<module>, $URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get isAbsolute, $URL.get search, $URL.get searchParams, $URL.get origin, $URL.get fullpath, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON, $URL.toString)
- src/utils.ts: 4 changes (withQuery, getQuery, getParams, withParams)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 12 changes (<module>, UFO.append, UFO.constructor, UFO.get auth, UFO.get host, UFO.get href, UFO.get origin, UFO.get originWithAuth, UFO.get search, UFO.get searchParams, UFO.toJSON, UFO.toString)

**After:**

- Verify that a URL with repeated query keys and values can be read as query parameters through its query string and search parameters, then updated while retaining the original path and other query values; expect the updated URL to encode the query correctly.
- Check that a URL containing encoded username, password, hostname, and port exposes the decoded credentials and hostname and the expected port, and serializes the credentials safely in the URL.
- Confirm that parsing relative and absolute URL inputs reports whether each is absolute and produces the expected origin, full path, and complete URL; verify that converting the URL to text or JSON yields that complete URL.
- Test appending a relative URL to another URL; expect its path to join the existing path, its query values to be merged, and its hash to replace the existing hash, while appending a URL with a protocol is rejected.

_For a developer:_
- src/parse.ts: 5 changes (parsePath, parseAuth, parseHost, stringifyParsedURL, parsedParamsToObject)
- src/query.ts: 2 changes (encodeQueryItem, stringifyQuery)
- src/url.ts: 15 changes (<module>, $URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get isAbsolute, $URL.get search, $URL.get searchParams, $URL.get origin, $URL.get fullpath, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON, $URL.toString)
- src/utils.ts: 4 changes (withQuery, getQuery, getParams, withParams)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 12 changes (<module>, UFO.append, UFO.constructor, UFO.get auth, UFO.get host, UFO.get href, UFO.get origin, UFO.get originWithAuth, UFO.get search, UFO.get searchParams, UFO.toJSON, UFO.toString)

## ufo-02 run 3 (24 gaps)

**Before (code names):**

- src/parse.ts: 4 changes (parseAuth, parseHost, parseParams, parsedParamsToObject)
- src/url.ts: 9 changes ($URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get origin, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 8 changes (UFO.append, UFO.get auth, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get search, UFO.get searchParams, UFO.toJSON)
- src/utils.ts: 2 changes (getParams, withParams)

**After:**

- Verify a URL with encoded username and password and a host with a port exposes its username, password, hostname, and port as separate readable values.
- Check that a URL’s origin contains its protocol and host but not its credentials, its href includes encoded credentials, and converting it to JSON produces the same text as its href.
- Test appending a relative URL to another URL: confirm its path is joined, its query values are merged, and its hash is applied; confirm appending a URL with a protocol is rejected.
- Verify that a URL with repeated query keys can be read as multiple values and serialized in the search string, including keys with empty values.
- Check that reading parameters from a URL returns its query values, and that adding parameters to a URL produces a URL containing the supplied values while retaining its existing parts.

_For a developer:_
- src/parse.ts: 4 changes (parseAuth, parseHost, parseParams, parsedParamsToObject)
- src/url.ts: 9 changes ($URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get origin, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 8 changes (UFO.append, UFO.get auth, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get search, UFO.get searchParams, UFO.toJSON)
- src/utils.ts: 2 changes (getParams, withParams)
