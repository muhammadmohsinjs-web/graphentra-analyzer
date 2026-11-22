# Graphentra QA Impact Report

Evidence Identity: 1cc94fca2f54a057cff0d14d2ea19366930dec92baa8ef77895dd50d74800919

Summary: This release introduces new URL and query composition logic that shapes how every request URL is built by the fetch client.

Key changes:
- Request paths are now joined to a configured base URL with exactly one separating slash: trailing slashes on the base are stripped first, a path that already starts with the base is left unchanged, and requests without a base (or with the root as base) keep the path as-is.
- Query parameters are appended or merged rather than replaced wholesale: URLs that already contain a query string keep their original parameters, scalar values overwrite same-named keys, undefined values delete a matching key when merging and are simply dropped when the URL has no query string yet, and arrays expand into repeated keys.
- Query values are serialized consistently: null becomes an empty value, numbers and booleans use their string form, and objects are JSON-serialized.

QA checks:
- Verify that outgoing requests resolve to the intended full URL when a base URL is configured, covering base URLs with and without a trailing slash and paths with and without a leading slash so exactly one slash separates them.
- Confirm paths that already begin with the configured base URL are not double-prefixed, and requests sent without a base URL use their path unchanged.
- Check query merging against a URL that already has parameters: undefined values remove matching params, arrays produce repeated keys, objects serialize to JSON strings, null becomes an empty value, and the original parameters are preserved.
- Ensure URLs stay clean when no parameters apply, with no dangling question mark or empty query string.

Uncertainty:
- No automated test coverage is linked to the changed URL logic or the fetch factory in the analyzed graph, so expected URL formats must be validated against intended behavior rather than an established baseline.
