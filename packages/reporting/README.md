# @graphentra/reporting

LLM impact reporting and persistent application context engine for Graphentra.

## Overview

`@graphentra/reporting` provides:
- Semantic interpretation of deterministic graph and change evidence.
- Context extraction and persistence (`application-context.json`).
- Automated, structured QA change-impact reports via LLMs.
- Strict semantic validation and bounded correction retry loops.

## Usage

```ts
import { generateQAReport, getOrCreateApplicationContext } from '@graphentra/reporting';

// Generate QA report from deterministic impacts and context
const { qaReport, markdownReport } = await generateQAReport(impacts, applicationContext, {
  apiKey: process.env.OPENROUTER_API_KEY,
});
```
