# Graphentra QA Impact Report

Evidence Identity: 5015f57b4050ba34e326426d8c22fd95d2d5bcf37b4eadcffabd7daea068328f

Summary: How $fetch combines per-request options with instance defaults was reworked for headers and query parameters, affecting every request made through the fetch pipeline, including derived instances.

Key changes:
- Per-request headers and instance defaults are now merged into a single Headers object for each request, with request-level headers winning over same-named defaults, and headers falling back to those of a supplied Request object when per-request options define none.
- Query parameters supplied through either the params or query key, from both request options and defaults, are combined into one object that is exposed as both query and params on the resolved options.
- Because all requests resolve options through this merged path, the new combination behavior applies to $fetch calls and to derived instances created via $fetch.create() alike.

QA checks:
- Verify a derived $fetch.create() instance sends the union of default and per-request headers, with a per-request header overriding a same-named default while other default headers are preserved.
- Check a request whose URL query draws on both defaults and per-request values via the params and query keys contains each parameter exactly once with the expected values.
- Ensure header merging accepts plain objects, arrays of key-value pairs, and Headers instances without dropping entries.
- Confirm a Request passed as the input still contributes its headers when the per-request options omit headers.

Uncertainty:
- The query/params merge order is not fully visible in the diff, so which side wins when the same key exists in both defaults and request options should be confirmed during QA.
