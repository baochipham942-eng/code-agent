# Chat Render Optimization Round 1

Generated: 2026-06-15

## Scope

This round kept the existing chat UI behavior and focused on two measured main-thread hotspots:

- Large no-overlap diff computation.
- Initial rendering of long syntax-highlighted code blocks.

## Before And After

Source reports:

- Before: `docs/perf/chat-render-baseline-before-fast-diff.md`
- After: `docs/perf/chat-render-baseline-latest.md`

| Benchmark | Before mean ms | After mean ms | Improvement |
|---|---:|---:|---:|
| `turnDiffSummary.10-files-500-lines` | 290.836 | 2.014 | 144.4x |
| `diffLines.5000-lines` | 2852.357 | 1.579 | 1806.4x |
| `markdownHighlight.10x500-line-code-blocks` | 12333.073 | 41.386 | 298.0x |
| `projectTurns.1000-turns` | 1.751 | 1.585 | 1.1x |
| `streamingOverlay.20k-delta` | 0.09 | 0.082 | 1.1x |

Browser smoke, before and after the collapsed preview change:

| Browser metric | Before | After | Improvement |
|---|---:|---:|---:|
| Mount settled | 1786.7 ms | 869.5 ms | 2.1x |
| Long task total | 1876 ms | 939 ms | 2.0x |
| Long task max | 1429 ms | 515 ms | 2.8x |

## What Changed

- Added `diffLinesWithFastPath` for whole-file replacement diffs with no shared non-empty lines.
- Reused that diff path in `TurnDiffSummary` aggregation and `DiffView`.
- Added runtime timing summaries to `window.__CODE_AGENT_STREAMING_PERF__`.
- Made long code blocks render collapsed on the first render instead of highlighting the full code once before collapsing.
- Made collapsed long-code previews use lightweight plain text; syntax highlighting now waits until the user expands the block.
- Added a repeatable synthetic baseline script at `scripts/perf/chat-render-baseline.tsx`.
- Added a real browser smoke at `scripts/perf/chat-render-browser-smoke.ts`, using system Chrome CDP first and falling back to bundled Chromium if CDP is unavailable.

## Remaining Hotspots

- The browser fixture still records 3 long tasks while rendering 10 collapsed long code blocks plus a 10,002-row diff. The diff calculation is low-cost now, but very large diff DOM output can still block the main thread.
- Worker-based or async syntax highlighting remains useful for expanded large blocks, but it is no longer paid on first render for collapsed blocks.

## Verification

- `npx vitest run tests/renderer/components/messageContent.codeBlock.test.tsx tests/renderer/utils/fastDiff.test.ts tests/renderer/utils/turnDiffSummary.test.ts tests/renderer/utils/streamingPerformanceMetrics.test.ts tests/renderer/hooks/useTurnProjection.test.ts tests/renderer/utils/streamingProjectionOverlay.test.ts`
- `npx tsx scripts/perf/chat-render-baseline.tsx`
- `npx tsx scripts/perf/chat-render-browser-smoke.ts`
