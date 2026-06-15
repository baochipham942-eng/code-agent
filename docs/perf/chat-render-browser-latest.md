# Chat Render Browser Performance Smoke

Generated: 2026-06-15T02:58:46.704Z

## Browser

- Provider: playwright-bundled
- Executable: /Users/linchen/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
- Mode: headless
- CDP port: null
- Fallback reason: system_chrome_unavailable: system Chrome could not be started or did not expose CDP.

## Rendered Fixture

- Code blocks: 10
- Code lines per block: 500
- Streaming chars: 24400
- Diff lines: 5000
- Diff rows rendered: 2560

## Browser Timing

- Mount settled: 564.1 ms
- Long task count: 6
- Long task total: 1081 ms
- Long task max: 286 ms

## Runtime Metrics Snapshot

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.diff.lines_ms | 2 | 3.05 | 3.9 | 3.9 | 2.2 |
| stream.code.preview_ms | 20 | 97.15 | 115.5 | 119 | 83.7 |
| stream.markdown.render_ms | 2 | 300.15 | 301.8 | 301.8 | 301.8 |

## Long Tasks

- self: start=677.8 ms duration=286 ms
- self: start=967.8 ms duration=282 ms
- self: start=1560.8 ms duration=86 ms
- unknown: start=1649 ms duration=69 ms
- self: start=1742.6 ms duration=221 ms
- self: start=1963.6 ms duration=137 ms
