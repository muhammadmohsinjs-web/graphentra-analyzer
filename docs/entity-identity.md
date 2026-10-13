# Entity identity

Decision record: ADR-0007 Language-Neutral Entity Identity and Kinds. Implementation: `packages/analyzer/src/entity-identity.ts`.

## Grammar

- `ID = <repo-relative file>#<qualifiedName>`. Parse by splitting at the last `#`: file paths may contain `#`, qualified names never contain a raw `#`.
- Segments are joined by `.` (member to container: `Cart.add`) and `>` (nested entity to enclosing entity: `Cart.add>helper`).
- Reserved segments `<module>` (whole-file module entity) and `default` (anonymous default export) are written literally and never escaped.
- Escaping: in a raw name segment, `# . > < ( ) , ~ %` and space are percent-encoded as `%` plus two uppercase hex digits (`a.b` -> `a%2Eb`, `List<T>` -> `List%3CT%3E`, `100%` -> `100%25`). Everything else is kept, including `?`, `!`, `$` and non-ASCII (Ruby `valid?` stays `valid?`).
- Accessors: `get x` / `set x`: literal prefix, one unescaped space, escaped name (`Cart.get total`).
- Overload disambiguator (Java, C#, Kotlin; never TypeScript): `name(T1,T2)` with each type escaped and joined by a literal `,` (`Cart.add(int)`, `Map.put(K,V)`).
- Duplicates: the 2nd, 3rd, ... occurrence of the same full ID in source order gets `~2`, `~3`, ...

Entities carry a separate `language` field (`typescript`, `javascript`) that is not part of the ID. `Entity.name` holds the full qualified name, so `id === file + '#' + name` always holds.

## TypeScript / JavaScript constructs

| Construct | Kind | ID | Notes |
| --- | --- | --- | --- |
| `function f(){}` | function | `file#f` | unchanged from legacy |
| `const f = () => {}` / `= function(){}` | function | `file#f` | `useCallback`/`useMemo`/`memo`/`forwardRef` wrappers unwrapped |
| class method | method | `file#C.m` | container C |
| constructor | method | `file#C.constructor` | |
| get/set accessors | method | `file#C.get x` / `file#C.set x` | |
| class property initialized with an arrow | method | `file#C.handle` | |
| object-literal method on a const | method | `file#obj.m` | |
| default export function/arrow | function | `file#default` | |
| PascalCase function returning JSX in .tsx/.jsx | component | `file#Button` | |
| top-level code | module | `file#<module>` | |
| overloads | one entity | `file#f` | range spans all signatures |
| nested function | function | `file#outer>inner` | always prefixed, not only on collision |
| non-literal computed name (`[Symbol.iterator]`) | none in Phase 1 | | lines fall to container/module |
| duplicates | any | `~2`, `~3` suffix | info diagnostic `DUPLICATE_ENTITY_ID_DISAMBIGUATED` in extended; legacy aborts with `AMBIGUOUS_ENTITY_ID` |
