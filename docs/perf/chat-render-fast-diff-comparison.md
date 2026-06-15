# Chat Render Fast Diff Comparison

Generated: 2026-06-15

## Change

Added a conservative renderer diff fast path for whole-file replacement cases where old and new text share no non-empty lines. In that case the UI can build the same remove-all/add-all diff shape without running the expensive `diffLines` LCS path.

## Evidence

Source reports:

- Before: `docs/perf/chat-render-baseline-before-fast-diff.md`
- After: `docs/perf/chat-render-baseline-latest.md`

| Benchmark | Before mean ms | After mean ms | Improvement |
|---|---:|---:|---:|
| `turnDiffSummary.10-files-500-lines` | 290.836 | 2.014 | 144.4x |
| `diffLines.5000-lines` | 2852.357 | 1.579 | 1806.4x |

## Interpretation

The first optimization materially reduces the measured diff hotspot for large no-overlap edits. Projection and streaming overlay were already low-cost in this synthetic baseline.

## Verification

- `npx vitest run tests/renderer/utils/fastDiff.test.ts tests/renderer/utils/turnDiffSummary.test.ts tests/renderer/utils/streamingPerformanceMetrics.test.ts tests/renderer/hooks/useTurnProjection.test.ts tests/renderer/utils/streamingProjectionOverlay.test.ts`
- `npx tsx scripts/perf/chat-render-baseline.tsx`
