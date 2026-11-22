# Graphentra QA Impact Report

Evidence Identity: 5015f57b4050ba34e326426d8c22fd95d2d5bcf37b4eadcffabd7daea068328f

Summary: Request resolution now combines default and per-call options into one configuration, with headers and query/params computed afterward so computed values take precedence over the base fields.

Key changes:
- Defaults are applied first and per-call options override the shared base fields, while query/params and headers are recomputed and set afterward.
- Header merging builds from default headers and overlays per-call headers, and still returns a usable headers object when defaults are absent.
- Query and params are kept as the same merged record when any query-ish source exists; when no such source exists they are left unset rather than becoming an empty object.

QA checks:
- Check headers for defaults-only, per-call-only, and combined cases and confirm per-call headers override defaults while the result is usable as headers.
- Check header inputs in Headers, array-of-pairs, and record-style forms and confirm the same per-call-over-default ordering.
- Check query/params with defaults, per-call values, and both present and confirm query and params match; also check the no-query case stays unset.
- Confirm default-only requests still resolve and per-call values with absent defaults are not corrupted by the merge step.

Uncertainty:
- The exact default-versus-per-call precedence inside query/params is not fully confirmed.
