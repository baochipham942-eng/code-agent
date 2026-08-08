# Agent Neo Landing Page V11 Design QA

final result: passed

## Review target

- Prototype: `docs/acceptance/landing-page-v2/index.html`
- Current review URL: `http://127.0.0.1:8765/docs/acceptance/landing-page-v2/index.html?v=44`
- State in scope: desktop download, digital employees, and realtime voice.
- User corrections: the web version is not publicly available and must not be offered; `专业角色` must be renamed to `数字员工`.

## Source and implementation evidence

- Download source visual truth: `image-audit-v10/02-desktop-download-focused.jpg`.
- Download implementation: `image-audit-v11/05-desktop-download-1265x712.jpg`.
- Download combined comparison: `image-audit-v11/08-compare-download-before-after.png`.
- Role source visual truth: `image-audit-v6/04-roles.jpg`.
- Digital employee implementation: `image-audit-v11/06-digital-employees-1265x712.jpg`.
- Role-to-employee combined comparison: `image-audit-v11/09-compare-role-to-employee.png`.
- Realtime voice implementation: `image-audit-v11/07-realtime-voice-1265x712.jpg`.
- Realtime voice source asset: `capability-assets/realtime-voice-dialogue-current-full.jpg`; marketing crop: `capability-assets/realtime-voice-dialogue-current.jpg`.

## Viewport and normalization

- Browser viewport override: 1265 × 712 CSS pixels, DPR 1.
- Browser content capture: 1250 × 704 output pixels after in-app browser pane chrome.
- The older source images were normalized to 1250 × 704 for the numeric comparison; no implementation screenshot was stretched for the qualitative review.
- Download and capability comparisons use the same dark theme, desktop density, and selected state.

## Findings and comparison history

- P1, fixed: the earlier download section exposed an online version even though web access is not public. The online card, `使用线上版` Hero CTA, and every visible online-version statement are removed.
- P1, fixed: the desktop download cards previously competed with a highlighted online card. macOS stable and Windows test are now the only two choices; local platform recommendation remains visible.
- P1, fixed: the capability label and copy used `专业角色`. The tab, lead copy, kicker, title, description, alt text, and caption now consistently use `数字员工`.
- P2, fixed: the old role screenshot visibly contained the `专家` page heading and `新建专家` action. The new crop focuses on the five employee cards, so the marketing page no longer presents conflicting category terminology.
- P2, fixed: the realtime-voice dialogue mentioned direct web access. The product capture was reshot with desktop-only download dialogue while preserving two conversation turns and the live listening strip.
- Post-fix review: no actionable P0/P1/P2 mismatch remains in the changed regions.

## Required fidelity surfaces

- Fonts and typography: the existing Neo font stack, title scale, tab weights, body line height, and English kicker styling are preserved. `数字员工` wraps only where the established responsive layout requires it.
- Spacing and layout rhythm: download changes stay inside the existing card system. Two desktop cards use the prior card height, padding, radius, and action-row rhythm; the capability shell is unchanged.
- Colors and tokens: existing night background, primary indigo, accent green, border opacities, and status colors are reused.
- Image quality and asset fidelity: the digital employee crop uses the current real product screen and removes only conflicting page chrome. The realtime voice asset is a current 1280 × 720 product capture with an 800 × 620 marketing crop; neither image is stretched.
- Copy and content: no public-web claim remains in the HTML or rendered download DOM. macOS is labelled stable, Windows is labelled test, and digital employee terminology is consistent across visible copy and accessibility text.

## Interaction and accessibility checks

- Hero has one primary action, `下载桌面版`, leading to the download section.
- The download section exposes macOS Apple Silicon, macOS Intel, and Windows x64 links; no online card or online CTA exists.
- Current-browser detection still marks macOS as `适合本机` without hiding Windows.
- Capability tabs switch to `数字员工` and `实时语音` with matching title, copy, proof chips, image, alt text, and caption.
- Realtime voice continues to show two dialogue turns, listening state, call duration, mute, and end-call controls in one frame.

## Quantitative and guard evidence

- Download comparison passed with intentional-change budget: diff ratio 0.254653.
- Role-to-digital-employee comparison passed with intentional-change budget: diff ratio 0.310844.
- Guard contract allows `.download` and `.hero-actions`; the Hero copy, artwork, proof rail, header, and signal strip remain protected.
- `public/code-agent/index.html` remains frozen and unchanged.
