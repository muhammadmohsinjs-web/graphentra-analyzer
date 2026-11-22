# Graphentra QA Impact Report

Evidence Identity: f8ef0769f17505e0a8680312834ba22b9597fd6ede834d96be0c708619974344

Summary: This release only adds or tightens TypeScript return types, so no runtime HTTP client behavior should change.

Key changes:
- All three edits are type-level only: they annotate return types for the Node fetch adapter, payload-method detection, and JSON serializability without changing executable logic.
- The Node adapter still uses FETCH_KEEP_ALIVE to choose default versus keep-alive agents, payload-method detection still covers PATCH, POST, PUT, and DELETE, and JSON serializability still excludes streams, buffers, FormData, and URLSearchParams.
- Request lifecycle, retry, and error-normalization paths that call these helpers are expected to behave exactly as before.

QA checks:
- Verify requests using PATCH, POST, PUT, and DELETE still follow the same payload and retry behavior, while GET remains treated as non-payload.
- Check JSON bodies are still auto-serialized while streams, buffers, FormData, and URLSearchParams continue to pass through unchanged.
- Confirm the Node adapter still switches between default and keep-alive agents correctly when FETCH_KEEP_ALIVE is unset, false, or true.
