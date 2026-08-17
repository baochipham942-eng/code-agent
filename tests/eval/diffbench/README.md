# Neo diff renderer benchmark

This harness compares the production `DiffView`, CodeMirror Merge, and `@pierre/diffs` in headless Chromium. It changes no production source.

## Fixtures

- `history-500`, `history-2000`, `history-5000`: ordered hunk content from commit `415fb045e797238d5e06ddc531a489c9004c0403`.
- `long-line-2400`: historical changed lines expanded past 2,000 characters.
- `pure-add-5000`: 5,000 real added lines from commit `7e1a30788f2aef3186be088c0a156d387c5835ee`, with an empty old document.

Regenerate and verify provenance:

```bash
rtk proxy node tests/eval/diffbench/generate-fixtures.mjs
```

## Install and run

Candidate packages are isolated under this directory and do not enter the production dependency graph.

```bash
rtk proxy npm ci --prefix tests/eval/diffbench
DIFFBENCH_HEAD=$(git rev-parse HEAD) \
DIFFBENCH_BRANCH=$(git branch --show-current) \
rtk proxy npx tsx tests/eval/diffbench/run.mts --warmups 1 --repetitions 3
```

On macOS workers, Chromium may need to run outside the filesystem/process sandbox because Mach port registration is denied inside it. The output is `results/2026-08-17.json`.

For a focused diagnostic run, set both selectors:

```bash
DIFFBENCH_RENDERER=codemirror \
DIFFBENCH_FIXTURE=history-5000 \
rtk proxy npx tsx tests/eval/diffbench/run.mts --warmups 1 --repetitions 1
```

The primary comparison holds visible capability constant: read-only unified layout, all context expanded, word/character diff disabled, and syntax highlighting disabled. Capability differences are evaluated separately.
