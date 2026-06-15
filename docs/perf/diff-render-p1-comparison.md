# Diff Render P1 Comparison

Generated: 2026-06-15

## Scope

This P1 pass targets large diff expansion rendering cost in `DiffView` and `TurnDiffSummary`.
Diff calculation was already low-cost after the previous fast path, so this round focuses on reducing browser main-thread work from mounting thousands of diff rows at once.

## Evidence

Source reports:

- Before: `docs/perf/diff-render-browser-before-p1.md`
- After: `docs/perf/diff-render-browser-latest.md`

| Browser metric | Before | After | Improvement |
|---|---:|---:|---:|
| Single 5k diff max long task | 298 ms | 56 ms | 81.2% lower |
| Single 5k diff duration to initial sample | 684 ms | 412 ms | 39.8% lower |
| TurnDiffSummary expansion max long task | 170 ms | 0 ms | 100% lower |
| TurnDiffSummary expansion duration | 774.2 ms | 756.5 ms | 2.3% lower |

## What Changed

- Large `DiffView` instances now render an initial bounded chunk and append more rows across animation frames.
- Small diffs still render fully on the first render.
- `DiffLineRow` is memoized, and rows use `content-visibility: auto` with an intrinsic row size to reduce off-screen layout and paint work.
- `DiffView` exposes `data-diff-total-rows`, `data-diff-rendered-rows`, and `data-diff-render-complete` for perf harnesses and future regression checks.
- Added a diff-only browser smoke at `scripts/perf/diff-render-browser-smoke.ts`.

## Interpretation

The main-thread spikes are materially lower. The tradeoff is intentional: very large diffs finish filling in over more frames, so total expansion duration can be slightly longer, but the UI avoids large blocking tasks. Final row counts still reach the full diff, as shown by the after smoke's `totalDiffRows: 16008`.

## Remaining P2 Risks

- Real viewport virtualization would reduce total DOM size more deeply, but it is a larger interaction change and should be handled separately.
- Expanded huge code blocks still rely on synchronous syntax highlighting after the user expands them.
- A real private long-session trace was not used; the evidence here is synthetic but repeatable and browser-backed.

## Verification

- `npx vitest run tests/renderer/components/diffView.progressive.test.tsx tests/renderer/utils/fastDiff.test.ts tests/renderer/utils/turnDiffSummary.test.ts`
- `npx tsx scripts/perf/diff-render-browser-smoke.ts`
- `npx tsx scripts/perf/chat-render-baseline.tsx`
- `npx tsx scripts/perf/chat-render-browser-smoke.ts`
- `npx vitest run tests/renderer/components/diffView.progressive.test.tsx tests/renderer/components/messageContent.codeBlock.test.tsx tests/renderer/utils/fastDiff.test.ts tests/renderer/utils/turnDiffSummary.test.ts tests/renderer/utils/streamingPerformanceMetrics.test.ts tests/renderer/hooks/useTurnProjection.test.ts tests/renderer/utils/streamingProjectionOverlay.test.ts`
- `npm run typecheck`
- `npm run build:renderer`
