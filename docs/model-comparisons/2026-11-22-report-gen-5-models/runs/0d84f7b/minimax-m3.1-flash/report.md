# Graphentra QA Impact Report

Evidence Identity: 5015f57b4050ba34e326426d8c22fd95d2d5bcf37b4eadcffabd7daea068328f

Summary: Request option resolution and header merging were rewritten in the HTTP client core, changing how per-call headers and query parameters combine with instance defaults.

Key changes:
- Request-level headers now override instance defaults for the same header name, and headers are only constructed from defaults when defaults exist; otherwise the request headers are used as-is.
- When a request object is passed, its headers are now used as the request-level header source when no explicit header option is supplied.
- The query and params aliases are now consolidated into one parameter set that is sent under both names, with per-request params applied on top of default query/params values.
- The resulting option object is layered as defaults first and per-call options second, so per-call options continue to take precedence over defaults.
- Both changes are reached by the client factory, so every request made through the client uses the new merge rules.

QA checks:
- Verify that a request-level header with the same name as a default header replaces the default value, while headers present only in defaults are still sent.
- Check that a request carrying its own headers, with no explicit header option and no defaults, sends those headers unchanged.
- Test that query and params both appear on the outgoing request URL and that per-request params override default query values of the same key.
- Confirm that per-call options override instance defaults for other option fields while default-only fields still apply.
- Ensure requests with neither defaults nor query/params still go out without unexpected query parameters.

Uncertainty:
- The evidence shows the merged query object is exposed under both the query and params names, but it does not establish how the downstream client renders a params alias into the final request URL.
