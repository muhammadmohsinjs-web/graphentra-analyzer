# V-13e plain checks: side by side (data-v4, 33 reports with gaps)

## consola-02 run 1 (3 gaps)

**Before (code names):**

- createConsola in src/consola.ts
- <module> in src/log.types.ts
- createConsola in src/consola.node.ts

**After:**

- Verify that the Node logger uses the basic reporter in CI or test mode and the fancy reporter otherwise, and that its log level follows the configured environment value when one is provided.
- Check that the logging types module exposes Types as a named export rather than as a default export.
- Confirm that calling the logger factory with options returns a new logger instance that can be used to log.

## consola-02 run 2 (6 gaps)

**Before (code names):**

- createConsola in src/consola.ts
- <module> in src/index.shared.ts
- <module> in src/log.types.ts
- createConsola in src/consola.browser.ts
- src/consola.node.ts: 2 changes (<module>, createConsola)

**After:**

- Verify the shared entry point exposes the logging type constants, log-level constants, log-object check, and global-assignment helper as named exports.
- Check that creating a logger through the exported factory with supplied options produces a logger that follows those options.
- Confirm that setting the logging-level environment variable does not override the default level selected for the runtime mode.

_For a developer:_
- createConsola in src/consola.browser.ts
- <module> in src/consola.node.ts

## consola-02 run 3 (9 gaps)

**Before (code names):**

- createConsola in src/consola.ts
- _createConsola in src/index.browser.ts
- src/index.ts: 2 changes (_createConsola, _getDefaultLogLevel)
- <module> in src/log.types.ts
- src/consola.browser.ts: 2 changes (<module>, createConsola)
- src/consola.node.ts: 2 changes (<module>, createConsola)

**After:**

- Verify that creating a logger with options applies the supplied settings to its observable logging behavior.
- Check that the browser package’s default logger sends logs through the browser reporter.
- Verify that the Node package’s default logger uses the expected default log level for debug, test, and ordinary environments, and that the environment level override changes which messages are emitted.
- Confirm that the log types are available as a named export from their public module.
- Check whether importing the Node package sets a logger on the global object.

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

- Verify consumers can create a console through the shared entry point and use its supported exports.
- Check that a console created with prompt options exposes prompting, and that text and password prompts accept input while the password is displayed masked.
- Test that confirmation prompts initially select Yes by default, allow choosing No, and return the corresponding true or false result.
- Test that single-choice prompts display their options and return the selected value, and that key-based choices can be selected and returned.
- Check that prompt symbols and note borders remain readable with and without terminal color codes, and that intro, outro, cancel, and log messages display their supplied text with the appropriate status symbols.
- Verify that a spinner displays its message while running, updates its indicator, and stops when requested.
- Check that grouped prompts run in order, pass earlier answers to later prompts, and return the collected answers.

_For a developer:_
- <module> in examples/prompt.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- src/index.ts: 3 changes (<module>, createConsola, _createConsola)

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

- Verify running the prompt example starts its prompt flow.
- Verify creating a logger with a custom prompt makes that prompt available through the logger, and creating one without reporters uses the default reporter for the environment.
- Verify the default browser and terminal logger instances can log messages in their respective environments.
- Test password and confirmation prompts in a terminal; verify password input is masked and the confirmation shows Yes and No with Yes initially selected.
- Test grouped multiple-choice prompts and a group of prompts in a terminal; verify a required group needs a selection and later prompts can use earlier answers.
- Test the prompt utilities in a terminal by displaying a note with colored text, intro, outro and cancel messages, and informational, success, step, warning and error messages; verify the messages are visible.
- Test a terminal spinner by starting and stopping it with a message; verify it displays activity while running and a completion message when stopped.

_For a developer:_
- <module> in src/index.shared.ts
- <module> in src/types.ts
- s in src/utils/prompt.ts

## consola-03 run 3 (28 gaps)

**Before (code names):**

- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 2 changes (<module>, _createConsola)
- src/utils/prompt.ts: 21 changes (<module>, s, symbol, password, selectKey, groupMultiselect, strip, note, cancel, intro, outro, log.message, log.info, log.success, log.step, log.warn, log.warning, log.error, spinner, ansiRegex, group)

**After:**

- Test a password prompt by entering a secret and confirm the displayed input is masked while the submitted value is the entered secret.
- Verify a keyboard-driven single-choice prompt lets you move through the supplied options and submit a choice, and a grouped multiple-choice prompt returns the selected options.
- Check terminal prompt output for the expected symbols as prompts become active, submit, cancel, or show an error, and confirm note boxes align correctly when messages include colored text.
- Verify the terminal display helpers show their supplied opening, closing, cancellation, and log messages with the appropriate symbols, and that a started spinner can be stopped.
- Test a group of prompts and confirm each later prompt receives earlier answers and the group returns the collected answers.

_For a developer:_
- <module> in examples/prompt.ts
- Consola.constructor in src/consola.ts
- src/index.browser.ts: 2 changes (<module>, _createConsola)
- <module> in src/index.shared.ts
- src/index.ts: 2 changes (<module>, _createConsola)

## excalidraw-01 run 1 (17 gaps)

**Before (code names):**

- src/history.ts: 2 changes (SceneHistory.restoreEntry, SceneHistory.undoOnce)
- src/index.tsx: 9 changes (App.componentDidMount, App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeOpacity, App.changeBackgroundColor, App.redrawTextBoundingBox)
- createScene in src/scene/createScene.ts
- setSelection in src/scene/selection.ts
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

**After:**

- Verify that after saving a scene and reloading the application, the saved elements and restored app state appear correctly.
- Check that copying and pasting styles onto drawings updates their appearance, including text appearance when the pasted style is applied to text.
- Test changing a selected element’s opacity and background color, and confirm the canvas reflects both changes.
- Verify that moving selected elements forward or backward in the drawing order changes which overlapping element appears on top, and that undo and redo restore the respective order.
- Check that selecting a marquee updates the selected elements as the marquee moves and leaves the resulting selection visible.

_For a developer:_
- createScene in src/scene/createScene.ts

## excalidraw-01 run 2 (24 gaps)

**Before (code names):**

- src/history.ts: 3 changes (SceneHistory.restoreEntry, SceneHistory.redoOnce, SceneHistory.undoOnce)
- src/index.tsx: 13 changes (App.componentDidMount, App.onKeyDown, App.deleteSelectedElements, App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeProperty, App.changeOpacity, App.changeStrokeColor, App.changeBackgroundColor, App.redrawTextBoundingBox)
- createScene in src/scene/createScene.ts
- src/scene/selection.ts: 3 changes (setSelection, clearSelection, deleteSelectedElements)
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

**After:**

- Verify that undoing an edit restores the previous drawing and redoing it restores the edited drawing.
- Check that after reloading the editor, a previously saved drawing and its available app state are restored.
- Test changing the selected elements’ background color, stroke color, or opacity, and applying copied styles to pasted elements, and confirm the displayed styles update; for text, confirm its displayed bounds update when styles are pasted.
- Verify that deleting selected elements removes them while leaving unselected elements, and that the available layer-order controls move selected elements forward or backward as expected.

_For a developer:_
- createScene in src/scene/createScene.ts
- setSelection in src/scene/selection.ts
- clearSelection in src/scene/selection.ts

## excalidraw-01 run 3 (16 gaps)

**Before (code names):**

- src/index.tsx: 10 changes (App.pasteStyles, App.moveAllLeft, App.moveOneLeft, App.moveAllRight, App.moveOneRight, App.changeProperty, App.changeOpacity, App.changeStrokeColor, App.changeBackgroundColor, App.redrawTextBoundingBox)
- src/scene/selection.ts: 2 changes (setSelection, deleteSelectedElements)
- src/zindex.ts: 4 changes (moveOneLeft, moveOneRight, moveAllLeft, moveAllRight)

**After:**

- Verify moving selected objects forward and backward in the drawing order changes which object appears on top when they overlap, including when moving one object or a group.
- Check that changing selected objects’ background color, opacity, or stroke color updates their appearance, and that pasting styles onto copied objects also updates their appearance and keeps pasted text visibly fitted to its bounds.
- Verify you can select objects by dragging over them, then delete the selected objects while unselected objects remain in the drawing.

## excalidraw-02 run 1 (10 gaps)

**Before (code names):**

- src/actions/actionProperties.tsx: 5 changes (actionChangeStrokeColor.PanelComponent, actionChangeBackgroundColor.PanelComponent, actionChangeStrokeWidth.PanelComponent, actionChangeSloppiness.PanelComponent, actionChangeFontFamily.PanelComponent)
- ColorPicker in src/components/ColorPicker.tsx
- <module> in src/element/index.ts
- newTextElement in src/element/newElement.ts
- <module> in src/scene/index.ts
- getCommonAttributeOfSelectedElements in src/scene/selection.ts

**After:**

- Verify that while editing an element, the stroke color, background color, stroke width, sloppiness, and font controls show that element’s current values.
- Check that when multiple selected elements share a property value, the relevant property control shows that shared value.
- Verify that creating text places it centered on the chosen text position, with its size fitted to the text.

_For a developer:_
- ColorPicker in src/components/ColorPicker.tsx
- <module> in src/element/index.ts

## excalidraw-02 run 2 (2 gaps)

**Before (code names):**

- actionChangeSloppiness.PanelComponent in src/actions/actionProperties.tsx
- addTextElement in src/index.tsx

**After:**

- Verify the roughness control shows the value of the element being edited, even when other selected elements have a different roughness value.
- Check that submitting changed text for an existing text element updates its text, dimensions, and placement to match the submitted text and font.

## excalidraw-02 run 3 (1 gaps)

**Before (code names):**

- addTextElement in src/index.tsx

**After:**

- Verify that after submitting text, the cursor returns to its default state.

## excalidraw-03 run 1 (4 gaps)

**Before (code names):**

- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx
- LockIcon in src/components/LockIcon.tsx

**After:**

- Verify that clearing the canvas while zen mode is on turns zen mode off and restores the editor controls.
- Check that the lock control is hidden in zen mode and visible when zen mode is off.

_For a developer:_
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

## excalidraw-03 run 2 (3 gaps)

**Before (code names):**

- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

**After:**

- Verify zen mode is off when opening a fresh editor and after clearing the canvas.

_For a developer:_
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

## excalidraw-03 run 3 (3 gaps)

**Before (code names):**

- getDefaultAppState in src/appState.ts
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

**After:**

- Verify that after clearing the canvas or loading a drawing, Zen mode is off and the editor controls are displayed.

_For a developer:_
- FixedSideContainer in src/components/FixedSideContainer.tsx
- <module> in src/components/Island.tsx

## excalidraw-05 run 1 (6 gaps)

**Before (code names):**

- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- src/appState.ts: 2 changes (<module>, getDefaultAppState)
- getTotalStorageSize in src/excalidraw-app/data/localStorage.ts
- src/utils.ts: 2 changes (debounce, nFormatter)

**After:**

- Verify that the statistics panel is closed when the application starts and after resetting the scene.
- Check that clearing the canvas while the statistics panel is open leaves the panel open.
- Confirm that the statistics panel is not included when exporting the drawing.
- Validate that adding or removing drawing elements is reflected in the total storage size, and that large displayed sizes use abbreviated units such as k, M, or G.

_For a developer:_
- debounce in src/utils.ts

## excalidraw-05 run 2 (6 gaps)

**Before (code names):**

- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- getDefaultAppState in src/appState.ts
- src/excalidraw-app/data/localStorage.ts: 2 changes (getElementsStorageSize, getTotalStorageSize)
- src/utils.ts: 2 changes (debounce, nFormatter)

**After:**

- Verify the statistics panel is closed on a fresh or reset scene, then open it, clear the canvas, and confirm the panel remains open.
- Check that adding and saving drawing elements increases the elements storage size shown in the statistics panel and is reflected in the total storage size.
- Verify that large storage sizes in the statistics panel use abbreviated units such as k, M, or G, while smaller sizes use b.

_For a developer:_
- debounce in src/utils.ts

## excalidraw-05 run 3 (5 gaps)

**Before (code names):**

- actionClearCanvas.perform in src/actions/actionCanvas.tsx
- getDefaultAppState in src/appState.ts
- getStorageSizes in src/components/Stats.tsx
- src/utils.ts: 2 changes (debounce, nFormatter)

**After:**

- Verify that opening the Stats panel and then clearing the canvas leaves the panel open, while resetting the scene closes it.
- Check that after changing the scene, the displayed storage sizes update to reflect the new scene after a short delay.
- Confirm that sufficiently large storage-size values are displayed using compact units such as k, M, or G.

_For a developer:_
- debounce in src/utils.ts

## excalidraw-10 run 1 (2 gaps)

**Before (code names):**

- App.updateScene in src/components/App.tsx
- <module> in src/packages/excalidraw/example/App.js

**After:**

- Verify that updating the scene with library items does not add or replace items in the library.

_For a developer:_
- <module> in src/packages/excalidraw/example/App.js

## excalidraw-10 run 2 (2 gaps)

**Before (code names):**

- App.updateScene in src/components/App.tsx
- App.importLibraryFromUrl in src/components/App.tsx

**After:**

- Verify updating a scene through the editor API with library items adds those items to the library.
- Check that opening a library-sharing URL from another editor prompts before adding its items, and declining leaves the library unchanged.

## excalidraw-10 run 3 (4 gaps)

**Before (code names):**

- src/components/App.tsx: 2 changes (App.updateScene, App.importLibraryFromUrl)
- parseLibraryTokensFromUrl in src/data/library.ts
- <module> in src/packages/excalidraw/index.tsx

**After:**

- Verify updating the scene with library items makes those items appear in the Library with unpublished status.
- Check that opening a library link from a hash or legacy query URL imports its items as published, opens the Library, and removes the link parameter from the URL; confirm that a matching token skips the confirmation prompt and a nonmatching token requires confirmation.

## excalidraw-12 run 1 (2 gaps)

**Before (code names):**

- <module> in src/components/dropdownMenu/common.ts
- getDrodownMenuItemClassName in src/components/dropdownMenu/common.ts

**After:**


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

- Verify that selecting a social link from the menu closes the menu.

_For a developer:_
- LayerUI in src/components/LayerUI.tsx
- src/components/dropdownMenu/common.ts: 2 changes (<module>, getDrodownMenuItemClassName)
- <module> in src/constants.ts

## excalidraw-12 run 3 (3 gaps)

**Before (code names):**

- LayerUI in src/components/LayerUI.tsx
- <module> in src/components/dropdownMenu/common.ts
- getDrodownMenuItemClassName in src/components/dropdownMenu/common.ts

**After:**

- Verify that the clear-canvas confirmation remains visible after its menu closes, and that canceling dismisses the confirmation without clearing the drawing.

_For a developer:_
- <module> in src/components/dropdownMenu/common.ts
- getDrodownMenuItemClassName in src/components/dropdownMenu/common.ts

## pathe-01 run 1 (1 gaps)

**Before (code names):**

- relative in src/path.ts

**After:**

- Verify the relative path from "docs/guide" to "docs/api" is "../api".

## pathe-01 run 2 (2 gaps)

**Before (code names):**

- relative in src/path.ts
- format in src/path.ts

**After:**

- Verify that requesting the relative path from “/alpha/beta” to “/alpha/gamma” returns “../gamma”.
- Check that formatting path components with root “/”, directory “folder”, and base “file.txt” returns “/folder/file.txt”.

## pathe-01 run 3 (2 gaps)

**Before (code names):**

- relative in src/path.ts
- dirname in src/path.ts

**After:**

- Verify calculating the relative path from “/a/b” to “/a/c” returns “../c”.
- Check that calculating the directory of “foo/” returns “/”.

## ufo-01 run 1 (29 gaps)

**Before (code names):**

- src/encoding.ts: 2 changes (encodeHash, decode)
- src/index.ts: 7 changes (<module>, getParams, joinPath, joinURL, normalizeURL, parseURL, withParams)
- hasProtocol in src/parse.ts
- src/ufo.ts: 11 changes (UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get fullpath, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 8 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, normalizeURL, withParams, joinURL)

**After:**

- Verify URL parsing decodes percent-escaped values, leaves malformed escapes unchanged, and treats only inputs with a protocol followed by two slashes as protocol-based URLs.
- Check that serializing URLs preserves credentials, hostname and port, and the expected origin and path; verify spaces and other special characters in the path and hash are encoded, while braces and carets in the hash remain unescaped.
- Test joining a base URL with relative URL parts: expect path slashes to be joined without doubled boundary slashes, query parameters from later parts to be included, and a part containing a protocol to be rejected.
- Validate normalizing a URL returns its serialized form, and adding parameters retains existing parameters unless a supplied value replaces them.
- Confirm callers can access the URL utility exports from the package entry point.

## ufo-01 run 2 (36 gaps)

**Before (code names):**

- src/encoding.ts: 8 changes (<module>, encode, encodeHash, encodeQueryValue, encodeQueryKey, encodePath, encodeParam, decode)
- src/index.ts: 5 changes (<module>, getParams, joinPath, joinURL, withParams)
- src/parse.ts: 2 changes (parseURLNative, hasProtocol)
- src/ufo.ts: 12 changes (<module>, UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get fullpath, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 9 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, createURL, withParams, getParams, joinURL)

**After:**

- Verify URL encoding and decoding by using values with spaces, plus signs, reserved characters, brackets, and slashes in paths, query keys and values, and fragments; confirm each appears in the appropriate encoded form, valid escapes decode, and malformed escapes are returned unchanged.
- Check the exported URL utilities with relative and absolute URLs, including one with credentials and a port; confirm the reported protocol, absolute status, host, origin, authenticated origin, full path, href, string, and JSON representations reflect the URL, and that the parsing and utility exports are available.
- Test joining a base URL with relative URLs that include paths, query parameters, or fragments; confirm paths combine with single boundary slashes, appended parameters and fragments appear in the result, protocol-bearing appended URLs are rejected, and the slash helper utilities add or remove one leading or trailing slash and clean repeated path slashes without changing the protocol separator.
- Verify the parameter utilities on a URL with existing query parameters; confirm parameters can be retrieved and that adding or replacing parameters returns a URL containing the merged values, with the supplied values taking precedence.

## ufo-01 run 3 (26 gaps)

**Before (code names):**

- encodeHash in src/encoding.ts
- hasProtocol in src/parse.ts
- src/ufo.ts: 11 changes (<module>, UFO.get hasProtocol, UFO.get isAbsolute, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get auth, UFO.get href, UFO.append, UFO.toJSON, UFO.toString)
- src/utils.ts: 8 changes (withoutTrailingSlash, withTrailingSlash, withoutLeadingSlash, withLeadingSlash, cleanDoubleSlashes, normalizeURL, withParams, joinURL)
- src/index.ts: 5 changes (getParams, joinPath, joinURL, normalizeURL, withParams)

**After:**

- Verify a URL with a hostname, port, username, and password includes the encoded hostname and credentials in its origin and full URL.
- Check that a URL fragment containing braces or a caret keeps those characters readable in the serialized full URL.
- Confirm joining a base URL with relative path segments combines the paths with a single slash between them, preserves the base protocol separator, and throws an error if a segment has a protocol.
- Validate that normalizing a URL produces its string form, and that adding parameters preserves existing parameters unless the supplied parameters replace them.
- Test that converting a URL to a string or JSON produces the same URL text, and that a protocol URL is reported as absolute while a path beginning with a slash is also absolute.

_For a developer:_
- hasProtocol in src/parse.ts
- <module> in src/ufo.ts
- getParams in src/index.ts

## ufo-02 run 1 (30 gaps)

**Before (code names):**

- <module> in src/index.ts
- src/parse.ts: 4 changes (parseAuth, parseHost, parseParams, parsedParamsToObject)
- src/url.ts: 11 changes ($URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get hasProtocol, $URL.get origin, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON, $URL.toString)
- src/utils.ts: 3 changes (createURL, getParams, withParams)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 10 changes (<module>, UFO.append, UFO.get auth, UFO.get host, UFO.get href, UFO.get origin, UFO.get originWithAuth, UFO.get searchParams, UFO.toJSON, UFO.toString)

**After:**

- Verify that a URL with username and password exposes the decoded username and password, and that its encoded authentication text is percent-encoded.
- Check that a URL with a host and port exposes its hostname and port, and that its host and origin include the host and port.
- Confirm that a URL with a protocol and host exposes whether it has a protocol, and that its origin and full URL include the protocol and encoded host; a relative URL’s full URL is its full path.
- Test appending a relative URL to another URL: its query values are merged, its path is joined, and its fragment replaces the existing fragment when present; appending a URL with a protocol throws an error.
- Verify that converting a URL to text or JSON returns the same full URL.
- Check that the library’s public entry point makes the reorganized URL and query capabilities available to callers.

_For a developer:_
- encodeSearchParam in src/encoding.ts
- src/parse.ts: 2 changes (parseParams, parsedParamsToObject)
- src/ufo.ts: 2 changes (<module>, UFO.get searchParams)
- src/utils.ts: 2 changes (getParams, withParams)

## ufo-02 run 2 (39 gaps)

**Before (code names):**

- src/parse.ts: 5 changes (parsePath, parseAuth, parseHost, stringifyParsedURL, parsedParamsToObject)
- src/query.ts: 2 changes (encodeQueryItem, stringifyQuery)
- src/url.ts: 15 changes (<module>, $URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get isAbsolute, $URL.get search, $URL.get searchParams, $URL.get origin, $URL.get fullpath, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON, $URL.toString)
- src/utils.ts: 4 changes (withQuery, getQuery, getParams, withParams)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 12 changes (<module>, UFO.append, UFO.constructor, UFO.get auth, UFO.get host, UFO.get href, UFO.get origin, UFO.get originWithAuth, UFO.get search, UFO.get searchParams, UFO.toJSON, UFO.toString)

**After:**

- Verify that reading query data from a URL preserves its search parameters, and that adding query data keeps existing parameters while representing empty values and repeated values correctly in the search string and search parameters.
- Check a URL with encoded username, password, hostname, and port; confirm the separate properties decode correctly and its displayed address encodes the authentication and host correctly.
- Confirm that absolute URLs and relative paths produce the expected origin, full path, href, string, and JSON string, including query and fragment text.
- Validate that appending a relative URL joins its path, adds its query values, and uses its fragment, while attempting to append a URL with a protocol is rejected.
- Test adding query values to a URL and confirm the resulting URL retains its path and fragment while reflecting the merged query values.

## ufo-02 run 3 (24 gaps)

**Before (code names):**

- src/parse.ts: 4 changes (parseAuth, parseHost, parseParams, parsedParamsToObject)
- src/url.ts: 9 changes ($URL.get hostname, $URL.get port, $URL.get username, $URL.get password, $URL.get origin, $URL.get encodedAuth, $URL.get href, $URL.append, $URL.toJSON)
- encodeSearchParam in src/encoding.ts
- src/ufo.ts: 8 changes (UFO.append, UFO.get auth, UFO.get host, UFO.get origin, UFO.get originWithAuth, UFO.get search, UFO.get searchParams, UFO.toJSON)
- src/utils.ts: 2 changes (getParams, withParams)

**After:**

- Verify a URL containing encoded username and password, a hostname, and a port exposes the decoded credentials, hostname, port, and origin as expected, and serializes consistently through its URL string and JSON representation.
- Check that appending a relative URL combines its path, adds or replaces its query values, and uses its hash when present; confirm that appending a URL with a protocol is rejected.
- Test a URL with query parameters and confirm its search string and search-parameter view reflect those parameters, including repeated keys.
- Validate that the query-parameter utilities return the input URL’s parameters and produce a URL containing supplied parameters.
