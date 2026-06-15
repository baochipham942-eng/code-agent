# Code Highlight Browser Performance Smoke

Generated: 2026-06-15T02:47:04.542Z

## Browser

- Provider: playwright-bundled
- Executable: /Users/linchen/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
- Mode: headless
- CDP port: null
- Fallback reason: system_chrome_unavailable: system Chrome could not be started or did not expose CDP.

## Fixture

- Collapsed blocks: 10
- Collapsed lines per block: 500
- Expand lines: 1000, 5000

## Initial Collapsed Render

- Duration: 432 ms
- Rendered: {"plainPreviews":12,"expanded1000LastLinePresent":false,"expanded5000LastLinePresent":false}
- Long task count: 2
- Long task total: 536 ms
- Long task max: 280 ms

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.code.preview_ms | 24 | 70.271 | 91.3 | 93.6 | 53.9 |
| stream.markdown.render_ms | 2 | 275.8 | 276.8 | 276.8 | 276.8 |

Long tasks:

- self: start=576.3 ms duration=280 ms
- self: start=861 ms duration=256 ms

## Expand 1000 Lines

- Duration: 3999.9 ms
- Rendered: {"plainPreviews":11,"expanded1000LastLinePresent":true,"expanded5000LastLinePresent":false}
- Long task count: 1
- Long task total: 3806 ms
- Long task max: 3806 ms

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.code.highlight_ms | 1 | 3742.2 | 3742.2 | 3742.2 | 3742.2 |

Long tasks:

- self: start=1394.3 ms duration=3806 ms

## Expand 5000 Lines

- Duration: 18814.1 ms
- Rendered: {"plainPreviews":10,"expanded1000LastLinePresent":true,"expanded5000LastLinePresent":true}
- Long task count: 1
- Long task total: 18632 ms
- Long task max: 18632 ms

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.code.highlight_ms | 1 | 18335.3 | 18335.3 | 18335.3 | 18335.3 |

Long tasks:

- self: start=5403.3 ms duration=18632 ms
