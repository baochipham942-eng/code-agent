# Code Highlight Browser Performance Smoke

Generated: 2026-06-15T02:57:04.573Z

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

- Duration: 393.2 ms
- Rendered: {"plainPreviews":12,"expanded1000LastLinePresent":false,"expanded5000LastLinePresent":false}
- Long task count: 2
- Long task total: 466 ms
- Long task max: 246 ms

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.code.preview_ms | 24 | 44.646 | 63.8 | 65.9 | 29.8 |
| stream.markdown.render_ms | 2 | 244.15 | 245.1 | 245.1 | 245.1 |

Long tasks:

- self: start=566.9 ms duration=220 ms
- self: start=789.4 ms duration=246 ms

## Expand 1000 Lines

- Duration: 4193.4 ms
- Rendered: {"plainPreviews":11,"expanded1000LastLinePresent":true,"expanded5000LastLinePresent":false}
- Long task count: 7
- Long task total: 3943 ms
- Long task max: 1734 ms

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.code.highlight_ms | 7 | 573.114 | 1758.9 | 1758.9 | 312.2 |

Long tasks:

- self: start=1266.1 ms duration=99 ms
- self: start=1394.3 ms duration=161 ms
- self: start=1568 ms duration=234 ms
- self: start=1813.8 ms duration=443 ms
- self: start=2270.6 ms duration=961 ms
- self: start=3248.2 ms duration=1734 ms
- self: start=5008.5 ms duration=311 ms

## Expand 5000 Lines

- Duration: 19879.9 ms
- Rendered: {"plainPreviews":10,"expanded1000LastLinePresent":true,"expanded5000LastLinePresent":true}
- Long task count: 15
- Long task total: 19567 ms
- Long task max: 7042 ms

| Timing | Count | Mean ms | P95 ms | Max ms | Last ms |
|---|---:|---:|---:|---:|---:|
| stream.code.highlight_ms | 9 | 2180.144 | 7155 | 7155 | 4425.9 |

Long tasks:

- self: start=5482.8 ms duration=200 ms
- self: start=5686.6 ms duration=169 ms
- self: start=5903.1 ms duration=276 ms
- self: start=6225.9 ms duration=600 ms
- self: start=6826.7 ms duration=52 ms
- self: start=6885.5 ms duration=932 ms
- self: start=7817.8 ms duration=59 ms
- self: start=7885.4 ms duration=1951 ms
- self: start=9836.7 ms duration=60 ms
- self: start=9904.6 ms duration=3616 ms
- self: start=13521 ms duration=77 ms
- self: start=13609.5 ms duration=7042 ms
- self: start=20652.3 ms duration=108 ms
- self: start=20778 ms duration=4362 ms
- self: start=25140.3 ms duration=63 ms
