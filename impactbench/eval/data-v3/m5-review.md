# M5 noise review

Totals: TRUE_GAP 13, FALSE_FLAG 15, TRIVIAL 19 (47 items)

| item | id | entity | verdict | reason |
|---|---|---|---|---|
| 1 | consola-03 | consola.ts#Consola._logFn | TRIVIAL | Type cast only, no behaviour change |
| 2 | consola-03 | prompt.ts#selectKey>opt | FALSE_FLAG | Single-choice prompt rendering covered by report |
| 3 | consola-03 | prompt.ts#cancel | TRUE_GAP | Cancel message output never tested |
| 4 | consola-03 | prompt.ts#intro | TRUE_GAP | Intro banner output never tested |
| 5 | consola-03 | prompt.ts#outro | TRUE_GAP | Outro message output never tested |
| 6 | excalidraw-01 | resizeTest#getElementWithResizeHandler | TRIVIAL | readonly type annotation only |
| 7 | excalidraw-01 | history#generateCurrentEntry | TRIVIAL | readonly type annotation only |
| 8 | excalidraw-01 | history#redoOnce | TRUE_GAP | Redo restore path changed, no redo check |
| 9 | excalidraw-01 | history#undoOnce | TRUE_GAP | Undo restore path changed, no undo check |
| 10 | excalidraw-01 | index.tsx#<module> | TRIVIAL | const to let, no visible behaviour |
| 11 | ufo-02 | encoding.ts#<module> | TRIVIAL | Empty before and after |
| 12 | ufo-02 | parse.ts#parseAuth | FALSE_FLAG | Username/password exposure check covers it |
| 13 | ufo-02 | parse.ts#parseHost | FALSE_FLAG | Host check covers it (port regex looks buggy) |
| 14 | ufo-02 | url.ts#$URL.get port | FALSE_FLAG | Port listed in URL details key change |
| 15 | ufo-02 | url.ts#$URL.get hasProtocol | FALSE_FLAG | web+demo protocol check covers protocol detection |
| 16 | excalidraw-10 | App.tsx#<module> | TRIVIAL | Import cleanup only |
| 17 | excalidraw-10 | json.ts#<module> | TRIVIAL | Unused import removed |
| 18 | excalidraw-10 | example App.js#renderFooter | TRIVIAL | Ref renamed to API, same call |
| 19 | excalidraw-10 | example App.js#updateScene | FALSE_FLAG | Example scene updates check covers it |
| 20 | excalidraw-10 | example App.js#onCopy | FALSE_FLAG | Example clipboard copy check covers it |
| 21 | ufo-01 | encoding.ts#encodeHash | TRUE_GAP | Hash encoding never checked |
| 22 | ufo-01 | encoding.ts#encodeQueryValue | TRUE_GAP | Space, plus, ampersand encoding untested |
| 23 | ufo-01 | encoding.ts#encodeQueryKey | TRUE_GAP | Equals-sign key encoding untested |
| 24 | ufo-01 | encoding.ts#decode | TRUE_GAP | Malformed percent-sequence fallback untested |
| 25 | ufo-01 | parse.ts#<module> | TRIVIAL | Type declarations only |
| 26 | excalidraw-05 | localStorage.ts#<module> | TRIVIAL | Empty before and after |
| 27 | excalidraw-05 | selection.ts#isSomeElementSelected | TRIVIAL | Formatting refactor, same logic |
| 28 | excalidraw-05 | selection.ts#getSelectedElements | TRIVIAL | Formatting refactor, same logic |
| 29 | excalidraw-05 | utils.ts#<module> | TRIVIAL | Comment line only |
| 30 | excalidraw-05 | utils.ts#nFormatter | FALSE_FLAG | Storage figures check covers it (format unspecified) |
| 31 | excalidraw-12 | DropdownMenuContent#<module> | TRIVIAL | Import lines only |
| 32 | excalidraw-12 | DropdownMenuItemLink | FALSE_FLAG | Menu choice select key change covers it |
| 33 | excalidraw-12 | common.ts#<module> | TRIVIAL | Internal context plumbing, untestable |
| 34 | excalidraw-12 | common.ts#getDrodownMenuItemClassName | FALSE_FLAG | Shared base styling key change covers it |
| 35 | excalidraw-12 | utils.ts#<module> | TRIVIAL | Comment lines only |
| 36 | excalidraw-03 | App.tsx#<module> | TRIVIAL | Empty before and after |
| 37 | excalidraw-03 | FixedSideContainer#<module> | FALSE_FLAG | Edge panel styling key change covers it |
| 38 | excalidraw-03 | Island#<module> | FALSE_FLAG | Styling bundle key change covers it |
| 39 | excalidraw-03 | LayerUI#LayerUI | TRUE_GAP | GitHub corner Zen-mode transition untested |
| 40 | consola-02 | consola.ts#createConsola | FALSE_FLAG | Named factory check covers it |
| 41 | consola-02 | index.browser.ts#_createConsola | TRUE_GAP | Browser default logger reporter not covered |
| 42 | consola-02 | index.shared.ts#<module> | FALSE_FLAG | Named exports check covers it |
| 43 | consola-02 | index.ts#_createConsola | TRUE_GAP | CONSOLA_LEVEL env and CI reporter untested |
| 44 | consola-02 | index.ts#_getDefaultLogLevel | TRUE_GAP | Debug/test/default log level untested |
| 45 | excalidraw-02 | newElement.ts#<module> | TRIVIAL | Import lines only |
| 46 | excalidraw-02 | index.tsx#<module> | TRIVIAL | Import cleanup only |
| 47 | excalidraw-02 | index.tsx#addTextElement | FALSE_FLAG | Moved; text creation checks cover it |

## Per-report comparison (verify checks vs base)

| id | redundant | too technical | untestable | verdict | line |
|---|---|---|---|---|---|
| consola-03 | 0 | 3 | 1 | same | Broader coverage (browser, password, notes) but entry-point/global-logger checks are developer-only. |
| excalidraw-01 | 0 | 1 | 0 | same | Same three checks; paste check leans on "previous source-origin adjustment". |
| ufo-02 | 0 | 3 | 0 | same | Adds URL detail checks but exposes JSON/href/export internals; base is simpler. |
| excalidraw-10 | 1 | 2 | 0 | same | More thorough, but legacy-format and library-update capability wording needs code access. |
| ufo-01 | 0 | 1 | 0 | better | Adds slash-encoding and ordered output beyond base. |
| excalidraw-05 | 0 | 1 | 1 | same | Drops rotated-element check; adds vague "no behaviour change" check. |
| excalidraw-12 | 0 | 0 | 0 | worse | Fewer checks; loses ordinary-item close check that base had. |
| excalidraw-03 | 1 | 0 | 2 | worse | Vague "remain usable / presented appropriately" checks replace base's concrete visibility checks. |
| consola-02 | 0 | 1 | 0 | worse | Only two checks, drops Types and reporter-constructor exports checks. |
| excalidraw-02 | 0 | 0 | 0 | better | Adds multi-select width and color chooser checks, all concrete. |

Totals: redundant 2, too technical 12, untestable 4. Better 2, same 5, worse 3.
