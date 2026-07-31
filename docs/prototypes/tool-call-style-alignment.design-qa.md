# Tool Call Style Alignment · Design QA

- source visual truth: `artifacts/mock-guard/tool-call-style-alignment/source-focused.png`
- implementation: `docs/prototypes/tool-call-style-alignment.html`
- implementation screenshot: `artifacts/mock-guard/tool-call-style-alignment/implementation.jpg`
- focused comparison: `artifacts/mock-guard/tool-call-style-alignment/comparison.png`
- viewport: 1280 × 720 CSS px, desktop dark mode
- source pixels: 1532 × 244
- implementation pixels: 1280 × 720
- comparison normalization: source resized to 1200 px width; implementation tool region cropped from the same rendered viewport and resized to 1200 px width
- state: all tool states visible; ordinary failures collapsed; running and escalated failure expanded

## Findings

No actionable P0, P1, or P2 findings remain.

- Typography: system font stack, 11–14 px hierarchy, muted code label and status weight match the current dense desktop conversation language.
- Spacing and layout: ordinary tool rows share one 34 px lightweight shell; full-card borders were removed from ordinary failures; expanded details use a single left guide.
- Colors and tokens: neutral failures remain gray; running uses restrained blue; only user-action-required failure uses rose border and text.
- Image and icon fidelity: the prototype contains no raster product imagery; interface icons come from Phosphor Icons Web rather than hand-drawn SVG or CSS substitutes.
- Copy: ordinary failure copy explicitly says it does not require user handling; quota failure states impact and action without exposing a key.

## Intentional Differences From Source

- The source gives each `MemoryRead` failure a full outer border while the successful command row is bare. The prototype deliberately removes those two ordinary-failure borders.
- Successful and recovered rows omit redundant status text. Recovered state is communicated by a small `已恢复` badge.
- The prototype adds execution, escalated failure, and recovered states so the complete state hierarchy can be reviewed in one screen.

## Interaction Evidence

- Status filters: passed; selecting `普通失败` leaves exactly two visible groups.
- Ordinary failure: passed; click changes `aria-expanded` from `false` to `true`.
- Escalated failure: passed; click cannot collapse the forced-open group.
- Console errors: none.

## Comparison History

- Initial prototype added `完成` and a status dot to successful and recovered rows.
- Fix: success now reads only `运行了 2 条命令`; recovered now reads `读取任务状态` with a lightweight `已恢复` badge.
- Post-fix evidence: `artifacts/mock-guard/tool-call-style-alignment/implementation.jpg`.

## Follow-up Polish

- P3: confirm the final production component uses the repository icon package rather than the prototype CDN.
- P3: verify the same hierarchy at the app’s smallest supported desktop width during formal implementation.

final result: passed
