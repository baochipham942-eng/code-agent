# Neo diff renderer benchmark

This harness compares the production `DiffView` with the isolated CodeMirror Merge baseline in headless Chromium.

## Fixtures

- `history-500`, `history-2000`, `history-5000`: ordered hunk content from commit `415fb045e797238d5e06ddc531a489c9004c0403`.
- `long-line-2400`: historical changed lines expanded past 2,000 characters.
- `pure-add-5000`: 5,000 real added lines from commit `7e1a30788f2aef3186be088c0a156d387c5835ee`, with an empty old document.

Regenerate and verify provenance:

```bash
rtk proxy node tests/eval/diffbench/generate-fixtures.mjs
```

## Install and run

The baseline package remains isolated under this directory; production CodeMirror dependencies are declared at the repository root.

```bash
rtk proxy npm ci --prefix tests/eval/diffbench
DIFFBENCH_HEAD=$(git rev-parse HEAD) \
DIFFBENCH_BRANCH=$(git branch --show-current) \
rtk proxy npx tsx tests/eval/diffbench/run.mts --warmups 1 --repetitions 5
```

On macOS workers, Chromium may need to run outside the filesystem/process sandbox because Mach port registration is denied inside it. The output is `results/2026-08-17.json`.

For a focused diagnostic run, set both selectors:

```bash
DIFFBENCH_RENDERER=codemirror \
DIFFBENCH_FIXTURE=history-5000 \
rtk proxy npx tsx tests/eval/diffbench/run.mts --warmups 1 --repetitions 1
```

The `codemirror` renderer preserves the spike baseline settings. The `current` renderer exercises production defaults, including collapsed unchanged sections and inline changes.

## Performance comparison

Committed `artifacts/` record the machine and harness version that generated them; they are not a valid performance control. Judge a regression only with a same-machine A/B capture: run the before and after revisions consecutively on the same machine.

At least two samples must reproduce a regression. For `history-5000`, use at least 5 repetitions: its metric is bimodal by roughly one 16.7ms frame, so a median from 3 repetitions can land in either cluster and produce a false regression.
