# Graphentra QA Impact Report

Evidence Identity: 1cc94fca2f54a057cff0d14d2ea19366930dec92baa8ef77895dd50d74800919

Summary: The URL handling feeding the fetch client is changing, so base-path joining and query serialization need QA validation together across the request-path flow.

Key changes:
- Relative request paths are joined to the base with a single separator, while inputs already starting with the normalized base are returned unchanged, so duplicate base prefixes and slash variants are QA-visible.
- URLs without an existing query string build the query from non-undefined values, repeat arrays as separate values, stringify numbers and booleans, JSON-encode objects, emit null as an empty value, and return the original URL when the effective query string is empty.
- URLs that already contain a query string merge rather than replace the whole string: scalar values set or replace a key, arrays append beyond existing values, undefined deletes the key, and unrelated parameters remain, with an empty resulting query removing the question mark entirely.

QA checks:
- Verify relative path and base combinations, including empty base or a slash-only base or path, both leading and trailing slash variants, and inputs already starting with the normalized base, so paths are joined exactly once and are not double-prefixed.
- Check query strings on URLs without a question mark: undefined entries are omitted, arrays repeat the key, numbers and booleans are stringified, objects are JSON-stringified, null is an empty value, and an empty effective query returns the original URL.
- Confirm URLs already containing a query string merge as expected: scalar values replace the key, array values append after any existing value, undefined deletes the key, unrelated parameters remain, and deleting all parameters removes the query marker entirely.
- Validate these base, path, and query outcomes through the request flow rather than slash or query behavior in isolation, including constructed URLs that reduce to the base path with no query string.

Uncertainty:
- No removed code is provided, so this change is evidenced as new URL logic rather than a proven before-versus-after behavior difference.
