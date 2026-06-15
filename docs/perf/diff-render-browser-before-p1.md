# Diff Render Browser Performance Smoke

Generated: 2026-06-15T02:22:39.112Z

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

- Duration: 684 ms
- Rows: {"singleDiffRows":10002,"summaryDiffRows":0,"totalDiffRows":10002}
- Long task count: 3
- Long task total: 595 ms
- Long task max: 298 ms

## TurnDiffSummary Expansion

- Expanded files: 3
- Duration: 774.2 ms
- Rows: {"singleDiffRows":10002,"summaryDiffRows":6006,"totalDiffRows":16008}
- Long task count: 3
- Long task total: 471 ms
- Long task max: 170 ms

## Initial Runtime Metrics

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.diff.lines_ms | 2 | 2.05 | 2.4 | 2.4 | 1.7 |
| stream.diff.summary_ms | 2 | 1.65 | 2.1 | 2.1 | 1.2 |

## Expansion Runtime Metrics

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.diff.lines_ms | 6 | 0.5 | 0.9 | 0.9 | 0.2 |

## Initial Long Tasks

- self: start=213.1 ms duration=58 ms
- self: start=272.3 ms duration=298 ms
- unknown: start=570.6 ms duration=239 ms

## Expansion Long Tasks

- self: start=1028.5 ms duration=170 ms
- self: start=1288.5 ms duration=131 ms
- self: start=1455 ms duration=170 ms
