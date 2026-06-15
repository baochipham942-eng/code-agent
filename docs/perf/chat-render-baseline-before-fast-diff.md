# Chat Render Performance Baseline

Generated: 2026-06-15T01:42:14.359Z

## Environment

- Node: v24.15.0
- Platform: darwin/arm64
- Package version: 0.16.104
- Mode: quick
- Git HEAD: 7ae5246a3
- Dirty entries at run: 45

## Fixtures

- Turns: 100, 1000
- Streaming delta chars: 25068
- Code blocks: {"count":10,"linesPerBlock":500}
- Diff files: {"count":10,"linesPerFile":500}
- Raw diff lines: 5000

## Results

| Benchmark | Mean ms | P95 ms | Max ms | Iterations | Output |
|---|---:|---:|---:|---:|---|
| projectTurns.100-turns | 0.146 | 0.17 | 0.173 | 20 | {"turns":100,"activeTurnIndex":-1,"nodes":200} |
| projectTurns.1000-turns | 1.751 | 4.762 | 4.762 | 10 | {"turns":1000,"activeTurnIndex":-1,"nodes":2000} |
| streamingOverlay.20k-delta | 0.09 | 0.162 | 0.185 | 20 | {"turns":1000,"activeNodes":2,"deltaChars":25068} |
| streamingBatcher.20k-append-chunks | 0.035 | 0.058 | 0.063 | 50 | {"inputUpdates":200,"mergedUpdates":1,"mergedChars":20000} |
| turnDiffSummary.10-files-500-lines | 290.836 | 292.165 | 292.165 | 5 | {"fileCount":10,"added":5000,"removed":5000} |
| diffLines.5000-lines | 2852.357 | 3014.45 | 3014.45 | 3 | {"chunks":2,"addedChunks":1,"removedChunks":1} |
| markdownHighlight.10x500-line-code-blocks | 12333.073 | 12456.183 | 12456.183 | 2 | {"htmlLength":6473950} |

## Runtime Metrics Snapshot

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.projection.base_ms | 35 | 0.78 | 3.784 | 4.704 | 4.704 |
| stream.projection.overlay_ms | 22 | 0.106 | 0.168 | 0.482 | 0.063 |
| stream.diff.summary_ms | 7 | 294.18 | 305.722 | 305.722 | 287.839 |

## Interpretation Notes

- This is a synthetic renderer-path baseline. It measures pure projection, streaming overlay, diff preparation, raw diffing, and markdown/highlight rendering with the current dependency stack.
- Browser FPS, dropped frames, and Chrome long tasks still need a rendered app smoke before final completion.
- Keep this file as the before/after comparison anchor for the first optimization pass.
