# Graphentra QA Impact Report

Evidence Identity: 1cc94fca2f54a057cff0d14d2ea19366930dec92baa8ef77895dd50d74800919

Summary: The release expands HTTP request URL construction with new base-path joining and structured query handling.

Key changes:
- Request URL joining now avoids adding a duplicate boundary slash when the base ends with one or the path begins with one, and configured bases have one trailing slash removed before joining.
- Applying a non-root base prepends it only when the input does not already start with it; empty or root bases leave inputs unchanged, avoiding duplicated base prefixes.
- For URLs without an existing query, undefined values are omitted, scalars are included, and arrays become repeated keys; for existing queries, undefined deletes matching keys, scalars replace them, and arrays append repeated entries, with the question mark removed after deletions leave no parameters.
- Query values now serialize null as empty, numbers and booleans as text, and objects as JSON, with URL encoding applied to the resulting parameters.

QA checks:
- Verify base and path combinations covering empty and root values, leading and trailing slashes, and an input already beginning with the base; confirm an empty or root base yields the path, an empty or root path yields the base, two absent values yield '/', and no duplicate separator or second base prefix is added.
- Confirm an absent or empty query object leaves the URL unchanged, and deleting the last existing parameter removes the question mark.
- Verify that undefined values are omitted when adding a query and delete matching keys in an existing query, scalar values replace matching existing keys, and arrays appear as repeated keys.
- Validate that null yields an empty value, numbers and booleans retain their string forms, objects become JSON text, and spaces or reserved characters are URL-encoded.
