# Phase V · V-2 spike results

Generated 2026-11-17 by `tools/verifier-spike.mts score`. Items: 150 (0 reviewed).
Positive class = **flag** ("not covered" / "not supported", label false). Recall-first: refusal, error or missing answer counts as a flag.
Gate (V-3, ADR-0011): recall ≥ 0.9 and precision ≥ 0.6 at one threshold.

> [!warning] 150 labels are still drafts. The gate is only valid with `--reviewed-only` after review.

## Summary

| Provider | Items | Answered | Refusals | Errors | Brier | Gate pick | Cost (USD) | p50 / p95 latency |
|---|---|---|---|---|---|---|---|---|
| judge | 150/150 | 145 | 0 | 5 | 0.201 | **FAIL** | 0.4447 | 31080 / 164462 ms |
| openai | 150/150 | 149 | 1 | 0 | 0.251 | **FAIL** | 0.0196 (est.) | 1794 / 2678 ms |

## judge

| Threshold | Recall (all) | Precision (all) | Flags | Coverage R / P | Trigger R / P | Faithfulness R / P |
|---|---|---|---|---|---|---|
| 0.3 | 60 % | 92 % | 49 | 53 % / 100 % | 36 % / 69 % | 100 % / 100 % |
| 0.4 | 60 % | 92 % | 49 | 53 % / 100 % | 36 % / 69 % | 100 % / 100 % |
| 0.5 | 60 % | 92 % | 49 | 53 % / 100 % | 36 % / 69 % | 100 % / 100 % |
| 0.6 | 60 % | 92 % | 49 | 53 % / 100 % | 36 % / 69 % | 100 % / 100 % |
| 0.7 | 60 % | 92 % | 49 | 53 % / 100 % | 36 % / 69 % | 100 % / 100 % |

Reliability (P(true) bins):

| Bin | n | mean P | fraction true |
|---|---|---|---|
| 0.0–0.2 | 44 | 0.05 | 0.07 |
| 0.2–0.4 | 0 | – | – |
| 0.4–0.6 | 0 | – | – |
| 0.6–0.8 | 0 | – | – |
| 0.8–1.0 | 101 | 0.94 | 0.70 |

Missed "not covered" items at t=0.5: `trigger:excalidraw-08:v2-base-1` (p=0.95), `trigger:consola-02:v2-base-1` (p=0.95), `trigger:excalidraw-12:v2-base-1` (p=0.90), `trigger:excalidraw-02:v2-base-1` (p=0.90), `trigger:ofetch-02:v2-base-1` (p=0.95), `trigger:ofetch-01:v2-base-1` (p=0.95), `trigger:consola-01:v2-base-1` (p=0.90), `trigger:json-server-01:v1-lookup-1` (p=0.95), `trigger:pathe-01:v1-base-1` (p=0.90), `trigger:excalidraw-01:v2-base-1` (p=0.95), `trigger:excalidraw-05:v1-lookup-1` (p=0.95), `trigger:excalidraw-08:v1-lookup-1` (p=0.90), `trigger:excalidraw-03:v1-base-2` (p=0.90), `coverage:excalidraw-05:v2-base-1` (p=0.98), `coverage:excalidraw-09:v2-base-1` (p=0.98), `coverage:excalidraw-03:v2-base-1` (p=0.98), `coverage:consola-02:v2-base-1` (p=0.95), `coverage:pathe-01:v2-base-1` (p=0.95), `coverage:ofetch-01:v2-base-1` (p=0.90), `coverage:excalidraw-01:v2-base-1` (p=0.95), `coverage:excalidraw-04:v2-base-1` (p=0.95), `coverage:consola-01:v1-base-1` (p=0.95), `coverage:excalidraw-02:v1-base-1` (p=0.90), `coverage:consola-03:v1-lookup-1` (p=0.95), `coverage:excalidraw-05:v1-base-1` (p=0.95), `coverage:excalidraw-09:v1-base-1` (p=0.95), `coverage:excalidraw-03:v1-lookup-always-2` (p=0.90), `trigger:excalidraw-04:v2-base-1` (p=0.90), `trigger:excalidraw-03:v2-base-1` (p=0.90), `trigger:excalidraw-06:v2-base-1` (p=0.95)

## openai

| Threshold | Recall (all) | Precision (all) | Flags | Coverage R / P | Trigger R / P | Faithfulness R / P |
|---|---|---|---|---|---|---|
| 0.3 | 49 % | 79 % | 47 | 60 % / 95 % | 16 % / 33 % | 75 % / 94 % |
| 0.4 | 52 % | 80 % | 49 | 60 % / 95 % | 20 % / 38 % | 80 % / 94 % |
| 0.5 | 55 % | 77 % | 53 | 60 % / 90 % | 28 % / 44 % | 80 % / 94 % |
| 0.6 | 55 % | 72 % | 57 | 60 % / 90 % | 28 % / 35 % | 80 % / 94 % |
| 0.7 | 63 % | 72 % | 65 | 60 % / 90 % | 40 % / 40 % | 95 % / 95 % |

Reliability (P(true) bins):

| Bin | n | mean P | fraction true |
|---|---|---|---|
| 0.0–0.2 | 41 | 0.01 | 0.12 |
| 0.2–0.4 | 7 | 0.28 | 0.57 |
| 0.4–0.6 | 8 | 0.48 | 0.75 |
| 0.6–0.8 | 11 | 0.69 | 0.27 |
| 0.8–1.0 | 82 | 0.98 | 0.68 |

Missed "not covered" items at t=0.5: `trigger:excalidraw-05:v2-base-1` (p=1.00), `trigger:excalidraw-08:v2-base-1` (p=0.74), `trigger:excalidraw-09:v2-base-1` (p=0.97), `trigger:excalidraw-03:v2-base-1` (p=0.69), `trigger:ofetch-02:v2-base-1` (p=0.96), `trigger:excalidraw-12:v2-base-1` (p=0.81), `trigger:excalidraw-02:v2-base-1` (p=0.69), `trigger:excalidraw-10:v2-base-1` (p=0.94), `trigger:excalidraw-13:v2-base-1` (p=0.97), `trigger:consola-01:v2-base-1` (p=0.98), `trigger:excalidraw-01:v2-base-1` (p=0.82), `trigger:ufo-01:v2-base-1` (p=0.64), `trigger:excalidraw-06:v2-base-1` (p=0.99), `trigger:excalidraw-04:v2-base-1` (p=0.94), `trigger:json-server-01:v1-lookup-1` (p=1.00), `trigger:excalidraw-05:v1-lookup-1` (p=0.99), `trigger:excalidraw-08:v1-lookup-1` (p=0.91), `trigger:excalidraw-09:v1-base-1` (p=0.78), `coverage:excalidraw-05:v2-base-1` (p=1.00), `coverage:excalidraw-09:v2-base-1` (p=1.00), `coverage:excalidraw-03:v2-base-1` (p=1.00), `coverage:pathe-01:v2-base-1` (p=1.00), `coverage:ofetch-01:v2-base-1` (p=1.00), `coverage:excalidraw-01:v2-base-1` (p=1.00), `coverage:excalidraw-04:v2-base-1` (p=1.00), `coverage:consola-01:v1-base-1` (p=1.00), `coverage:excalidraw-02:v1-base-1` (p=1.00), `coverage:consola-03:v1-lookup-1` (p=1.00), `coverage:excalidraw-05:v1-base-1` (p=1.00), `coverage:excalidraw-09:v1-base-1` (p=1.00), `faithfulness:excalidraw-13:v2-base-1-inv:3` (p=0.81), `faithfulness:consola-02:v2-base-1-inv:5` (p=0.69), `faithfulness:excalidraw-11:v2-base-1-inv:6` (p=0.66), `faithfulness:excalidraw-08:v2-base-1-inv:10` (p=0.61)

