# Graphentra QA Impact Report

Evidence Identity: 1cc94fca2f54a057cff0d14d2ea19366930dec92baa8ef77895dd50d74800919

Summary: The release adds URL and query construction behavior used when preparing HTTP client requests.

Key changes:
- Request URLs combine base paths and paths while avoiding duplicate or missing separators, and configured base paths are not added again when already present.
- Query parameters are serialized consistently: undefined values are omitted or removed, arrays produce repeated parameters, and null, numbers, booleans, and objects are converted to strings; existing query parameters are merged or updated.

QA checks:
- Verify URL construction with missing or root values and with both, neither, or one of the base/path separators present, including a base path already present in the input.
- Check query construction with no query, new and existing parameters, undefined values, arrays, and null, numeric, boolean, and object values; confirm arrays append repeated parameters to existing queries while scalar values update them.
