# R-2 smoke run: grading sheet

Luna (`openai/gpt-6-luna`), compact payload, `base` variant, 1 run per commit. For each commit, compare the report with the known regression and fill in `hand-grades.jsonl`:
- **catch:** a check, run as written, would expose the regression.
- **explained:** the report names the behaviour change that causes it.
- **area:** the report points QA at the right area.

Baseline (R-0, same model, verify variant): 11 of 36 reports caught in the ≤ 10 band (31%). excalidraw-19 and excalidraw-20 produced no report.

## consola-01 (consola, plain-logic)

**Known regression:** A burst of identical throttled logs never printed its final "(repeated N times)" line unless a different log followed.

**Fix commit:** fix: throttle expiration (#81)

**Report summary:** Repeated log messages suppressed within the throttle window are now counted and reported when a later log is processed.

- Identical messages repeated within the throttle window are still suppressed immediately, but their count is appended to the last repeated message when a different log is processed.

**Area: Console logging and repeated-message suppression**
1. Verify that after logging the same message twice more within the throttle window, then logging a different message, the earlier message appears with “(repeated 2 times)” appended and the different message is also logged.

## excalidraw-06 (excalidraw, same-signature-behavior)

**Known regression:** Undo did not work correctly after selecting text bound to a container, since the text was re-wrapped on selection.

**Fix commit:** fix: undo should work when selecting bounded textr (#4537)

**Report summary:** The release changes how selected objects and attached text are included and laid out during editing and formatting.

- Selection-based actions and selection information now include text attached to a selected shape or connector.
- Changing text size, font, or alignment—and pasting styles—now recalculates attached text wrapping and positioning, vertically centers it, and expands its container when the text exceeds the available height.

**Area: Canvas selection and bound-text formatting**
1. Verify that with the shape selected, increasing the attached text’s font size also formats the attached text, wraps it to the shape’s width, expands the shape to fit, and vertically centers the text.
2. Check that selection-dependent actions and selection information include the attached text when its shape is selected.
3. Confirm that pasting text styles onto attached text recalculates its wrapping and positioning and expands the shape when needed.

## excalidraw-07 (excalidraw, same-signature-behavior)

**Known regression:** Pressing Escape with the eraser tool active did not reliably return to the previous tool, and restoring saved appState did not normalize activeTool.lastActiveToolBeforeEraser.

**Fix commit:** fix: decouple actionFinalize and actionErase (#4984)

**Report summary:** Keyboard handling for the eraser now restores the previously active tool and avoids triggering drawing finalization while the eraser is active.

- Pressing Escape while the eraser is active now switches back to the previously active tool, or to selection if no prior tool was saved; Escape and Enter no longer trigger the finalize action while the eraser is active.

**Area: Canvas tool and keyboard interactions**
1. Verify that after activating the eraser with E, pressing Escape restores the shape tool that was active beforehand rather than leaving the eraser active.
2. Confirm that with a multi-element in progress and the eraser active, pressing Enter does not trigger finalization.

**Uncertainty:** The intended handling of Enter during an in-progress multi-element while the eraser is active is not documented.

## excalidraw-08 (excalidraw, plain-logic)

**Known regression:** Keyboard navigation/shortcuts in the color picker could throw when the gallery parent element was missing.

**Fix commit:** fix: Handle `ColorPicker` parentSelector being undefined (#5152)

**Report summary:** Color pickers gain a short list of recent custom element colors and keyboard support for choosing them, while canvas-background choices remain unchanged.

- Element background and stroke color pickers can show up to five distinct non-default colors from the most recently updated, non-deleted elements; QA can verify the list excludes deleted elements and updates the selected element when a swatch is chosen.
- The new custom swatches use the z, x, c, v, and b shortcuts, while canvas-background pickers do not show custom element colors.

**Area: Element background and stroke color pickers**
1. Verify that a non-deleted element with a non-default color appears in the custom-color section and that choosing its swatch applies that color.
2. Check that a deleted element’s color is absent and that no more than five distinct custom colors appear, ordered from most recently updated to least recently updated.
3. Confirm that with a custom color available, pressing z in the picker selects the first custom swatch and applies its color.

**Area: Canvas background color picker**
1. Verify that the canvas background picker does not show the element’s custom color and that its existing default color choices remain available.

**Uncertainty:** The custom swatch’s displayed shortcut uses the custom-color key, but its accessibility shortcut attribute is assigned using the default-color index; verify that assistive technology reports the shortcut that actually selects the swatch.

## excalidraw-09 (excalidraw, timing-limit-constant)

**Known regression:** Canvas rendering was throttled to animation frames, causing the canvas to lag behind or flicker while resizing the window.

**Fix commit:** fix: disable render throttling by default & during resize (#5451)

**Report summary:** Canvas updates are now rendered on an animation-frame schedule, coalescing rapid changes while preserving the latest update for a trailing render.

- Previously, each editor update rendered immediately; now rapid updates may be grouped into animation-frame renders, so the canvas and related render results can update later while settling on the latest scene.

**Area: Drawing editor canvas**
1. Verify that several scene changes made rapidly before a repaint, such as dragging an element through multiple positions, leave the canvas showing the final position after updates settle.
2. Check that rapid viewport changes leave the visible canvas and scrollbars reflecting the final viewport after updates settle.

**Uncertainty:** The render result is now delivered on an animation-frame schedule; the supplied context does not establish whether any consumer requires an immediate intermediate render.

## excalidraw-15 (excalidraw, same-signature-behavior)

**Known regression:** Hyperlinks and embed links containing &, <, > or quotes were stored with HTML entities (e.g. "test&amp;"), corrupting URLs.

**Fix commit:** fix: hyperlinks html entities (#9063)

**Report summary:** HTML attribute sanitization now handles more special characters across links, embedded content, restored drawings, and SVG output.

- Previously, attribute values escaped only double quotes; they now also escape ampersands, apostrophes, and angle brackets, so links and embedded content containing these characters should remain safe and usable.

**Area: Element links, embedded content, and SVG export**
1. Verify that the link URL https://example.com/?a=1&b=2 remains usable and retains both query parameters when followed; the ampersand now receives attribute escaping, unlike before.
2. Check that an SVG export of a drawing with that linked element remains usable and retains the link's query parameters.

## excalidraw-19 (excalidraw, plain-logic)

**Known regression:** Dragging the endpoint of an arrow bound inside a shape triggered the focus point editor instead of dragging the endpoint.

**Fix commit:** fix: Inside-inside bound arrow endpoint drag trigger focus point editor (#10771)

**Report summary:** The release adds direct editing of arrow-to-shape connection points and changes how those connections are detected and positioned.

- Selected, straight arrows with exactly two points can now show interactive connection points and a dashed guide, making the arrow’s attachment position visible and hoverable.
- Dragging a connection point can move an arrow end, attach it to another shape, or detach it; holding Alt while dragging switches the binding between inside and orbit modes, and releasing updates the connection.
- Arrow binding now uses updated shape hit testing and endpoint geometry, and the previous rectangular-corner avoidance adjustment is removed, so attachment placement near corners may differ.

**Area: Canvas arrow connections**
1. Verify that selecting the arrow shows its connection point and dashed guide, and that hovering the point highlights it.
2. Verify that clicking directly on the connection point without first moving the pointer, then dragging it to the second shape while holding Alt, starts the drag and attaches the arrow inside that shape.
3. Check that dragging a bound connection point away from all shapes and releasing leaves that arrow end free rather than attached to its former shape.
4. Confirm that dragging a bound arrow connection point to a rectangular shape near a corner leaves the arrow connected to that shape after release and after moving the shape.

**Uncertainty:** The intended exact placement of an arrow endpoint dragged to a rectangular corner is not established; the previous corner-avoidance adjustment has been removed.

## excalidraw-20 (excalidraw, same-signature-behavior)

**Known regression:** A rectangle that fully contained a frame was not treated as overlapping it, so dragging it over the frame did not add it as a child and box selection with frame clipping misbehaved.

**Fix commit:** fix: frame selection and membership (#11250)

**Report summary:** The release adds configurable box selection and adjusts canvas geometry handling for selection, interaction, frame contents, and exports.

- Box selection now defaults to contain and can be changed to overlap, which selects elements whose visible outlines or attached text intersect the selection box without requiring the full element bounds to fit inside it.
- Alt plus Ctrl or Command can start a lasso selection even when dragging begins over the selected elements’ common bounds; hovering over those bounds without Ctrl or Command now shows a move cursor.
- Rotated-element hit detection and freehand geometry calculations have changed, which can affect canvas selection and arrow connections to freehand strokes.
- Frame-content selection and export preparation now use element bounds to determine overlap, so verify which objects appear when working with frames and frame exports.

**Area: Drawing canvas box selection and lasso**
1. Verify that with the box selection preference set to overlap, dragging a selection box across only part of a shape selects it, while contain mode does not select that same partially crossed shape.
2. Check that a selection box fully enclosing an element selects it in contain mode.
3. Confirm that Alt plus Ctrl or Command while starting a drag over the selected elements’ common bounds starts lasso selection, and that hovering there without Ctrl or Command shows a move cursor.

**Area: Canvas element interaction and arrow connections**
1. Verify that clicking on the visible part of a rotated rectangle selects it, including a point on its rotated bounds outside its unrotated bounds.
2. Check that an arrow endpoint can connect to a freehand stroke and remains connected when the stroke is moved.

**Area: Frame contents and exports**
1. Confirm that exporting the frame includes elements that overlap its bounds and excludes overlapping elements associated with a different frame.

**Uncertainty:** No concrete freehand curve input is supplied that demonstrates a different intersection result under the increased iteration limit.

## json-server-01 (json-server, plain-logic)

**Known regression:** GET /:resource/:id without _embed returned the resource with an extra empty "undefined" key.

**Fix commit:** fix empty key/value when _embed is undefined/empty

**Report summary:** Resource detail responses now process an optional embedding query value before returning the requested resource.

- When a request includes an embedding query value, the detail response now looks up related records using that value and adds the result to the resource.

**Area: Resource detail retrieval**
1. Verify a detail request without an embedding query value still returns the requested resource, as it did before this change.

**Uncertainty:** The response for a request without an embedding query value is unclear because the new code still attempts a related-record lookup with an undefined value.

## json-server-02 (json-server, return-shape)

**Known regression:** Creating a router from a database file path failed with "db.getState is not a function".

**Fix commit:** Fix db.getState is not a function

**Report summary:** File-backed database access now uses an asynchronous adapter, so startup and data persistence behavior should be verified.

- When the database is configured with a file path, the server now uses an asynchronous rather than synchronous file adapter, so reading existing data and persisting changes may behave differently.

**Area: File-backed database persistence**
1. Verify that starting the server with the file path makes the existing record available.
2. Check that a change made to the file-backed data is persisted and remains available after restarting the server.

**Uncertainty:** The supplied context does not specify how to launch the server with a database file path or identify a page or API for checking the persisted data.

## ofetch-01 (ofetch, same-signature-behavior)

**Known regression:** The fetch function supplied to createFetch was invoked as a method of globalOptions, so it ran with the wrong receiver.

**Fix commit:** fix: avoid calling `fetch` with `globalOptions` context

**Report summary:** The release adds reusable fetch-client defaults that are applied to requests and can be overridden per request.

- Fetch clients can now use reusable defaults; request-specific options take precedence for matching properties, and request headers replace the default header set rather than merging with it.

**Area: Fetch client configuration and requests**
1. Verify a request with no per-request options uses the default method POST.
2. Check that setting the per-request method to GET overrides the default POST.
3. Confirm that supplying a per-request header replaces the default header set rather than adding to it.

**Uncertainty:** It is unclear whether replacing default headers with per-request headers, rather than merging them, is intended.

## ofetch-02 (ofetch, plain-logic)

**Known regression:** Responses with JSON-style content types such as application/vnd.api+json were returned as blobs instead of parsed JSON.

**Fix commit:** fix: generalise `application/json` content types (#75)

**Report summary:** The release changes how HTTP response bodies are converted into returned data.

- Responses are now parsed according to an explicit response-type option or detected content type, so callers can receive JSON values, strings, or binary data instead of every body being read as text and parsed.
- Content-type detection defaults missing headers to JSON, recognizes application/json and application/ld+json as JSON and text/* plus selected XML, HTML, and SVG types as text, and treats other nonempty types as binary.

**Area: HTTP response handling**
1. Verify that a response with content type application/vnd.api+json and a JSON body returns binary data; the previous behavior parsed the body as JSON.
2. Check that a response with content type application/octet-stream returns binary data rather than the text value produced by the previous behavior.
3. Confirm that selecting the JSON response type for a response labeled text/plain with a JSON body returns parsed JSON.

## pathe-01 (pathe, plain-logic)

**Known regression:** extname returned wrong results for dotfiles and edge names such as ".foo", "..", ".", "./" and "..foo".

**Fix commit:** fix(extname): handle edge cases wirth leading dot

**Report summary:** Path handling behavior changes for edge-case inputs, with no application pages or routes identified for testing.

- A leading-dot filename such as .env is now treated as having the extension .env, which also changes the extension and name returned when that path is parsed.
- When an empty extension is supplied, basename now returns an empty string instead of the full final path segment.
- Relative paths and formatted paths are now calculated from resolved path segments, so root and directory edge cases can produce different results.

**Area: Path utilities**
1. Verify that parsing .env returns base .env, extension .env, and name an empty string.
2. Check that requesting the basename of /dir/file with an empty extension returns an empty string.
3. Confirm that the relative path from / to /a is a, not ../a.
4. Validate that formatting root /, dir foo, and base bar returns /foo/bar.

## ufo-03 (ufo, plain-logic)

**Known regression:** withoutBase dropped the leading slash when the remainder started with a query, e.g. /api?test with base /api gave ?test.

**Fix commit:** fix(withoutBase): preserve leading slash

**Report summary:** The release adds path-base handling without identifying an application screen or route for manual testing.

- Paths can now be given a base prefix, or have a matching base prefix removed, with trailing slashes on the base normalized first.

**Area: URL and path normalization**
1. Verify adding base /docs/ to /docs/page returns /docs/page without duplicating the base.
2. Check removing base /docs/ from /docs/page returns /page, and removing it from /docs returns /.
3. Confirm adding base /app to /apple returns /apple and removing base /app from /apple returns le, reflecting prefix matching without a segment-boundary check.

**Uncertainty:** The new base-handling behavior has no supplied previous implementation, so an input that takes a different old path cannot be established.
