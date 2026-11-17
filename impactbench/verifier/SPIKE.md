# Phase V · V-2 spike results

Generated 2026-11-17 by `tools/verifier-spike.mts score --reviewed-only`. Items: 99 (99 reviewed).
Positive class = **flag** ("not covered" / "not supported", label false). Recall-first: refusal, error or missing answer counts as a flag.
Gate (V-3, ADR-0011): recall ≥ 0.9 and precision ≥ 0.6 at one threshold.

## Summary

| Provider | Items | Answered | Refusals | Errors | Brier | Gate pick | Cost (USD) | p50 / p95 latency |
|---|---|---|---|---|---|---|---|---|
| judge | 99/99 | 99 | 0 | 0 | 0.029 | **PASS** t=0.3 (R 92 %, P 100 %) | 0.2536 | 27927 / 121833 ms |
| openai-repeat-2 | 99/99 | 99 | 0 | 0 | 0.064 | **PASS** t=0.7 (R 92 %, P 92 %) | 0.0141 (est.) | 1261 / 1675 ms |
| openai-repeat-3 | 99/99 | 99 | 0 | 0 | 0.064 | **PASS** t=0.7 (R 92 %, P 92 %) | 0.0064 (est.) | 1237 / 1742 ms |
| openai | 99/99 | 99 | 0 | 0 | 0.064 | **PASS** t=0.7 (R 92 %, P 92 %) | 0.0141 (est.) | 1842 / 2801 ms |

## judge

| Threshold | Recall (all) | Precision (all) | Flags | Coverage R / P | Trigger R / P | Faithfulness R / P |
|---|---|---|---|---|---|---|
| 0.3 | 92 % | 100 % | 36 | 94 % / 100 % | – / – | 91 % / 100 % |
| 0.4 | 92 % | 100 % | 36 | 94 % / 100 % | – / – | 91 % / 100 % |
| 0.5 | 92 % | 100 % | 36 | 94 % / 100 % | – / – | 91 % / 100 % |
| 0.6 | 92 % | 100 % | 36 | 94 % / 100 % | – / – | 91 % / 100 % |
| 0.7 | 92 % | 100 % | 36 | 94 % / 100 % | – / – | 91 % / 100 % |

Reliability (P(true) bins):

| Bin | n | mean P | fraction true |
|---|---|---|---|
| 0.0–0.2 | 36 | 0.04 | 0.00 |
| 0.2–0.4 | 0 | – | – |
| 0.4–0.6 | 0 | – | – |
| 0.6–0.8 | 0 | – | – |
| 0.8–1.0 | 63 | 0.95 | 0.95 |

Missed "not covered" items at t=0.3: `coverage:excalidraw-03:v1-lookup-always-2` (p=0.90), `faithfulness:consola-03:v2-base-1:0` (p=0.95), `faithfulness:consola-02:v2-base-1:0` (p=0.95)

## openai-repeat-2

| Threshold | Recall (all) | Precision (all) | Flags | Coverage R / P | Trigger R / P | Faithfulness R / P |
|---|---|---|---|---|---|---|
| 0.3 | 82 % | 94 % | 34 | 100 % / 89 % | – / – | 68 % / 100 % |
| 0.4 | 85 % | 94 % | 35 | 100 % / 89 % | – / – | 73 % / 100 % |
| 0.5 | 85 % | 92 % | 36 | 100 % / 85 % | – / – | 73 % / 100 % |
| 0.6 | 85 % | 92 % | 36 | 100 % / 85 % | – / – | 73 % / 100 % |
| 0.7 | 92 % | 92 % | 39 | 100 % / 85 % | – / – | 86 % / 100 % |

Reliability (P(true) bins):

| Bin | n | mean P | fraction true |
|---|---|---|---|
| 0.0–0.2 | 34 | 0.00 | 0.06 |
| 0.2–0.4 | 1 | 0.39 | 0.00 |
| 0.4–0.6 | 1 | 0.40 | 1.00 |
| 0.6–0.8 | 3 | 0.65 | 0.00 |
| 0.8–1.0 | 60 | 0.98 | 0.95 |

Missed "not covered" items at t=0.7: `faithfulness:consola-02:v2-base-1:0` (p=0.99), `faithfulness:consola-03:v2-base-1:0` (p=0.95), `faithfulness:excalidraw-13:v2-base-1-inv:3` (p=0.81)

## openai-repeat-3

| Threshold | Recall (all) | Precision (all) | Flags | Coverage R / P | Trigger R / P | Faithfulness R / P |
|---|---|---|---|---|---|---|
| 0.3 | 82 % | 94 % | 34 | 100 % / 89 % | – / – | 68 % / 100 % |
| 0.4 | 85 % | 94 % | 35 | 100 % / 89 % | – / – | 73 % / 100 % |
| 0.5 | 85 % | 92 % | 36 | 100 % / 85 % | – / – | 73 % / 100 % |
| 0.6 | 85 % | 92 % | 36 | 100 % / 85 % | – / – | 73 % / 100 % |
| 0.7 | 92 % | 92 % | 39 | 100 % / 85 % | – / – | 86 % / 100 % |

Reliability (P(true) bins):

| Bin | n | mean P | fraction true |
|---|---|---|---|
| 0.0–0.2 | 34 | 0.00 | 0.06 |
| 0.2–0.4 | 1 | 0.39 | 0.00 |
| 0.4–0.6 | 1 | 0.40 | 1.00 |
| 0.6–0.8 | 3 | 0.65 | 0.00 |
| 0.8–1.0 | 60 | 0.98 | 0.95 |

Missed "not covered" items at t=0.7: `faithfulness:consola-02:v2-base-1:0` (p=0.99), `faithfulness:consola-03:v2-base-1:0` (p=0.95), `faithfulness:excalidraw-13:v2-base-1-inv:3` (p=0.81)

## openai

| Threshold | Recall (all) | Precision (all) | Flags | Coverage R / P | Trigger R / P | Faithfulness R / P |
|---|---|---|---|---|---|---|
| 0.3 | 82 % | 94 % | 34 | 100 % / 89 % | – / – | 68 % / 100 % |
| 0.4 | 85 % | 94 % | 35 | 100 % / 89 % | – / – | 73 % / 100 % |
| 0.5 | 85 % | 92 % | 36 | 100 % / 85 % | – / – | 73 % / 100 % |
| 0.6 | 85 % | 92 % | 36 | 100 % / 85 % | – / – | 73 % / 100 % |
| 0.7 | 92 % | 92 % | 39 | 100 % / 85 % | – / – | 86 % / 100 % |

Reliability (P(true) bins):

| Bin | n | mean P | fraction true |
|---|---|---|---|
| 0.0–0.2 | 34 | 0.00 | 0.06 |
| 0.2–0.4 | 1 | 0.39 | 0.00 |
| 0.4–0.6 | 1 | 0.40 | 1.00 |
| 0.6–0.8 | 3 | 0.65 | 0.00 |
| 0.8–1.0 | 60 | 0.98 | 0.95 |

Missed "not covered" items at t=0.7: `faithfulness:consola-02:v2-base-1:0` (p=0.99), `faithfulness:consola-03:v2-base-1:0` (p=0.95), `faithfulness:excalidraw-13:v2-base-1-inv:3` (p=0.81)

