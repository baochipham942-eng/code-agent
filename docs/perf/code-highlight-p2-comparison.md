# Code Highlight P2 Comparison

Generated: 2026-06-15

## Scope

This P2 pass targets expanded large code-block highlighting in `MessageContent` / `CodeBlock`.
Collapsed long-code previews were already lightweight after the earlier pass; the remaining hotspot was the synchronous Prism highlight paid after clicking "展开全部".

## Evidence

Source reports:

- Before: `docs/perf/code-highlight-browser-before-p2.md`
- After: `docs/perf/code-highlight-browser-latest.md`

| Browser metric | Before | After | Improvement |
|---|---:|---:|---:|
| 1000-line expand max long task | 3806 ms | 1734 ms | 54.4% lower |
| 1000-line expand complete duration | 3999.9 ms | 4193.4 ms | 4.8% slower |
| 5000-line expand max long task | 18632 ms | 7042 ms | 62.2% lower |
| 5000-line expand complete duration | 18814.1 ms | 19879.9 ms | 5.7% slower |
| Initial collapsed render max long task | 280 ms | 246 ms | 12.1% lower |

## What Changed

- Expanded long code blocks now show the full plain-text code immediately, then progressively replace chunks with syntax-highlighted chunks across animation frames.
- Highlight chunks are memoized so already-highlighted chunks do not rerun Prism on every progress update.
- The code block exposes `data-code-block-lines`, `data-code-highlighted-lines`, and `data-code-highlight-complete` for perf harnesses and future regression checks.
- Added a code-highlight browser smoke at `scripts/perf/code-highlight-browser-smoke.ts`.

## Interpretation

The main-thread spikes are much lower, which is the point of this pass. Total highlight completion time is slightly slower because work is spread across more frames. The full code remains visible during progressive highlighting, and the Copy button still copies the original complete code.

## Remaining Risks

- A true worker-based highlighter could reduce main-thread work further, but it requires a larger rendering path change.
- The synthetic browser fixture is repeatable and browser-backed, but it is still not a private real-session trace.
- `react-syntax-highlighter` remains expensive for very large highlighted output; this pass reduces blocking rather than eliminating highlight cost.

## Verification

- `npx tsx scripts/perf/code-highlight-browser-smoke.ts`
- `npx tsx scripts/perf/chat-render-baseline.tsx`
- `npx tsx scripts/perf/chat-render-browser-smoke.ts`
- `npx vitest run tests/renderer/components/messageContent.codeBlock.test.tsx tests/renderer/components/diffView.progressive.test.tsx tests/renderer/utils/fastDiff.test.ts tests/renderer/utils/turnDiffSummary.test.ts tests/renderer/utils/streamingPerformanceMetrics.test.ts tests/renderer/hooks/useTurnProjection.test.ts tests/renderer/utils/streamingProjectionOverlay.test.ts`
- `npm run typecheck`
- `npm run build:renderer`
