# Chat Render Performance Baseline

Generated: 2026-06-15T02:58:23.936Z

## Environment

- Node: v24.15.0
- Platform: darwin/arm64
- Package version: 0.16.104
- Mode: quick
- Git HEAD: 7ae5246a3
- Dirty entries at run: 71

## Fixtures

- Turns: 100, 1000
- Streaming delta chars: 25068
- Code blocks: {"count":10,"linesPerBlock":500}
- Diff files: {"count":10,"linesPerFile":500}
- Raw diff lines: 5000

## Results

| Benchmark | Mean ms | P95 ms | Max ms | Iterations | Output |
|---|---:|---:|---:|---:|---|
| projectTurns.100-turns | 0.11 | 0.18 | 0.21 | 20 | {"turns":100,"activeTurnIndex":-1,"nodes":200} |
| projectTurns.1000-turns | 2.105 | 10.935 | 10.935 | 10 | {"turns":1000,"activeTurnIndex":-1,"nodes":2000} |
| streamingOverlay.20k-delta | 0.096 | 0.284 | 0.312 | 20 | {"turns":1000,"activeNodes":2,"deltaChars":25068} |
| streamingBatcher.20k-append-chunks | 0.041 | 0.099 | 0.113 | 50 | {"inputUpdates":200,"mergedUpdates":1,"mergedChars":20000} |
| turnDiffSummary.10-files-500-lines | 1.718 | 1.842 | 1.842 | 5 | {"fileCount":10,"added":5000,"removed":5000} |
| diffLines.5000-lines | 1.648 | 1.678 | 1.678 | 3 | {"chunks":2,"addedChunks":1,"removedChunks":1} |
| markdownHighlight.10x500-line-code-blocks | 41.046 | 42.705 | 42.705 | 2 | {"htmlLength":21530} |

## Runtime Metrics Snapshot

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.projection.base_ms | 35 | 0.836 | 3.225 | 10.847 | 0.667 |
| stream.projection.overlay_ms | 22 | 0.133 | 0.296 | 1.008 | 0.069 |
| stream.diff.summary_ms | 7 | 1.783 | 2.284 | 2.284 | 1.719 |
| stream.diff.lines_ms | 5 | 1.592 | 1.666 | 1.666 | 1.666 |
| stream.markdown.render_ms | 3 | 46.335 | 56.957 | 56.957 | 39.364 |

## Interpretation Notes

- This is a synthetic renderer-path baseline. It measures pure projection, streaming overlay, diff preparation, raw diffing, and markdown/highlight rendering with the current dependency stack.
- Browser long-task evidence is captured separately by `npx tsx scripts/perf/chat-render-browser-smoke.ts`.
- Keep this file as the before/after comparison anchor for chat-render optimization passes.
