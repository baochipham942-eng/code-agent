# Diff Render Browser Performance Smoke

Generated: 2026-06-15T02:35:00.272Z

## Browser

- Provider: playwright-bundled
- Executable: /Users/linchen/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
- Mode: headless
- CDP port: null
- Fallback reason: system_chrome_unavailable: system Chrome could not be started or did not expose CDP.

## Fixture

- Single diff lines: 5000
- Summary files: 3
- Summary lines per file: 1000

## Initial Single Diff

- Duration: 412 ms
- Rows: {"singleDiffRows":5120,"summaryDiffRows":0,"totalDiffRows":5120}
- Long task count: 2
- Long task total: 108 ms
- Long task max: 56 ms

## TurnDiffSummary Expansion

- Expanded files: 3
- Duration: 756.5 ms
- Rows: {"singleDiffRows":10002,"summaryDiffRows":6006,"totalDiffRows":16008}
- Long task count: 0
- Long task total: 0 ms
- Long task max: 0 ms

## Initial Runtime Metrics

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.diff.lines_ms | 2 | 1.75 | 2 | 2 | 1.5 |
| stream.diff.summary_ms | 2 | 1.55 | 2.1 | 2.1 | 1 |

## Expansion Runtime Metrics

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.diff.lines_ms | 6 | 0.717 | 1.8 | 1.8 | 0.2 |

## Initial Long Tasks

- self: start=157 ms duration=52 ms
- self: start=210.3 ms duration=56 ms

## Expansion Long Tasks

- none recorded
