# ADR-0006: Evidence schema 3.0

Status: accepted (Phase 5)

## Context

Evidence 2.1 describes code entities and the relations between them. It does not say which parts of the product a change can reach: HTTP endpoints, UI routes, jobs, commands. That knowledge lives only in `application-map.json`, which is derived, carries presentation data (UI text, navigation, flows), and is not part of the evidence identity. Reviewers and downstream tools (test selection, risk views) need the reachable surfaces and the tests that cover them as evidence, so they are reproducible and hashed.

Existing consumers read 2.0 and 2.1 and must keep working. Legacy (2.0) and extended (2.1) output and goldens must stay byte-identical.

## Decision

1. **3.0 is 2.1 plus new optional fields.** Nothing in 2.1 is removed or renamed. The validator treats 3.0 as an extended schema and accepts everything 2.1 accepts. The new fields are an error in a 2.x document.
2. **Opt-in.** The default stays 2.1. `AnalyzeOptions.evidenceSchema: '3.0'` and CLI `--schema 3.0` enable it. Only the extended engine can emit 3.0; legacy plus `--schema 3.0` is an `INVALID_OPTIONS` error.
3. **New top-level fields**, all sorted: `surfaces` (by id), `surfaceEdges` (by `from|type|to`), `tests` (by id), `testMapping`, `config`, `adapters` (by id). Per impact: `affectedSurfaces`, sorted by depth then surfaceId and absent when empty.
4. **Node kinds.** `SurfaceNode` (ids `ui:<route>`, `api:<METHOD> <route>`, other kinds use their own prefix) and `TestNode` (id `test:<file>#<suite> > <name>`, one per `it/test` block, duplicates suffixed `#2`, `#3`).
5. **Edge kinds**, kept in `surfaceEdges` and not in `technicalGraph.relations`, so the 2.1 graph is unchanged: `SURFACE_HANDLED_BY` (surface to entity), `CALLS_ENDPOINT` (entity to api_endpoint surface), `TEST_COVERS` (test to entity or surface, `via` is `goto` or `import`). Every edge has a confidence of `proven` or `likely`.
6. **Reach.** One reverse search over the entity relations plus reversed `SURFACE_HANDLED_BY` and `CALLS_ENDPOINT`, depth limit 10. A path is as confident as its weakest edge.
7. **Identity.** Every new array is ordered inside `computeDeterministicEvidenceIdentity`, and keys are added to the hashed payload only when present. A 2.x payload is therefore identical to before and existing identities do not change. `config.sha256` (the hash of `graphentra.yml`) and `adapters` enter identity, so a changed config or adapter version changes the identity.
8. **Derived only.** UI text, text keys, navigation, access rules, and e2e flows stay in `application-map.json` and never enter evidence.
9. **Reading.** `readEvidence(doc)` validates 2.0, 2.1, or 3.0 and returns the document with `surfaces`, `surfaceEdges`, `tests` always arrays (empty for 2.x). `testMapping` stays optional and is never invented: it is present only when the document has one, and `testMappingAvailable` (boolean) says whether it is. 2.x documents never have one; a 3.0 document omits it when surface or test extraction failed, because an empty mapping would read as "no tests to run" or "everything covered". Consumers read through it instead of branching on the version.
10. **Failure isolation.** If surface or test extraction throws, evidence still has `surfaces: []` and `surfaceEdges: []` (or no tests) plus a `SURFACE_EXTRACTION_FAILED` or `TEST_EXTRACTION_FAILED` warning. A new frontier reason `dynamic_endpoint_url` reports client requests whose URL cannot be resolved.

### Surface kinds

All kinds are accepted by the schema so later phases do not need a new version.

| Kind | MVP emits? |
|---|---|
| api_endpoint | yes |
| cli_command | no |
| graphql_operation | no |
| library_export | no |
| mobile_screen | no |
| queue_consumer | no |
| rpc_method | no |
| scheduled_job | no |
| serverless_function | no |
| ui_route | yes |
| webhook | no |

## Consequences

- Teams can adopt 3.0 per run; nothing changes for existing 2.0 and 2.1 users, goldens, or identities.
- The version string and the new identity inputs are the only breaking part. A 3.0 document identity differs from the 2.1 one for the same change, by design.
- The validator now checks referential integrity across entities, surfaces, tests, and mappings, so a producer bug fails loudly instead of shipping a dangling reference.
- The JSON schema checks structure and enums; ordering and cross-references are checked in code only.
- Kinds the MVP does not emit are valid but unproven; adapters for them need their own certification before they are advertised.
- Consumers on the old reader keep working for 2.x and fail on 3.0 until they move to `readEvidence`.
