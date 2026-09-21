# @graphentra/ci-runner

The Graphentra CI Runner is the lightweight client adapter responsible for invoking `@graphentra/analyzer` in CI environments and submitting versioned deterministic evidence to the Graphentra Backend API.

Production flow:
```text
PR event -> CI checkout -> Analyzer -> Versioned evidence
                                           |
                                           v
                                    CI submission adapter
                                           |
                                           v
                                  Backend API -> LLM -> DB
                                                        |
                                                        v
                                                   Dashboard
```

---

## Proposed Backend API Contract

```http
POST /v1/analysis-runs HTTP/1.1
Host: api.graphentra.dev
Authorization: Bearer <scoped-graphentra-token>
Idempotency-Key: <sha256-hex>
Content-Type: application/json

{
  "repository": {
    "name": "org/repo",
    "remoteUrl": "https://github.com/org/repo.git"
  },
  "pullRequest": {
    "number": 42,
    "baseBranch": "main",
    "headBranch": "feature-xyz"
  },
  "comparisonPolicy": "merge-base-to-head",
  "evidence": { ... }
}
```

### Success Response:
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "id": "run_98fbc1023a",
  "status": "queued"
}
```

---

## Idempotency and Deterministic Identity

The submission `Idempotency-Key` is computed as a SHA-256 hash over:
- Repository name
- PR number (if present)
- Relative target path
- Comparison policy & resolved comparison refs
- Analyzer & schema versions
- Deterministic evidence content identity (`computeDeterministicEvidenceIdentity(evidence)`)

Volatile execution timestamps, host paths, and bearer credentials are explicitly excluded from this identity.

---

## GitHub Actions Workflow Example

```yaml
name: Graphentra Change Analysis

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  analyze-and-submit:
    runs-on: ubuntu-latest
    # Security Rule: Do not run with secrets on untrusted public forks
    if: github.event.pull_request.head.repo.full_name == github.repository

    steps:
      - name: Checkout PR Head
        uses: actions/checkout@v4
        with:
          # Fetch full history to compute merge-base
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Compute Merge Base
        id: git-refs
        run: |
          BASE_REF="origin/${{ github.base_ref }}"
          git fetch origin ${{ github.base_ref }} --depth=100
          MERGE_BASE=$(git merge-base $BASE_REF HEAD)
          echo "merge_base=$MERGE_BASE" >> $GITHUB_OUTPUT
          echo "head_sha=$(git rev-parse HEAD)" >> $GITHUB_OUTPUT

      - name: Run Graphentra CI Runner
        env:
          GRAPHENTRA_BACKEND_URL: https://api.graphentra.dev
          GRAPHENTRA_TOKEN: ${{ secrets.GRAPHENTRA_SUBMISSION_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: |
          npx @graphentra/ci-runner@0.1.0 \
            --target . \
            --base ${{ steps.git-refs.outputs.merge_base }} \
            --head ${{ steps.git-refs.outputs.head_sha }} \
            --repo ${{ github.repository }} \
            --pr ${{ github.event.pull_request.number }} \
            --output .graphentra/evidence.json

      - name: Archive Deterministic Evidence
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: graphentra-evidence-${{ github.event.pull_request.number }}
          path: .graphentra/evidence.json
          retention-days: 14
```

---

## Fork PR Security Policy

- **Untrusted Fork PRs:** Submission credentials must **never** be exposed directly to workflows triggered by untrusted fork pull requests (`pull_request`).
- **Trusted Handoff:** For open-source repositories accepting external contributions:
  1. The PR workflow generates the deterministic `evidence.json` with zero credentials (`graphentra-analyze`) and uploads it as an untrusted artifact.
  2. A separate trusted workflow (`workflow_run` on `completed` or GitHub App webhook) downloads the artifact, validates the schema and comparison SHAs against GitHub's API, and submits the validated evidence with scoped credentials.
  3. Never use `pull_request_target` to execute arbitrary unvetted code from the fork with secrets.
