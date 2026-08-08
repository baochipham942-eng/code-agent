# Mock Visual QA

final result: blocked

- source visual truth path: `docs/acceptance/landing-page-v2/audit-before-lower-v3.png`
- implementation screenshot path: `docs/acceptance/landing-page-v2/audit-after-lower-v3-capabilities.png`
- viewport: `1440x900`
- state: `lower-page-redesign`
- source size: `1425x891`
- implementation size: `1425x891`
- max diff ratio: `0.050000`
- actual diff ratio: `0.825573`
- changed pixels: `1048210`
- total pixels: `1269675`
- mean RGB absolute delta: `169.349632`
- max channel delta: `255`
- reason: `diff ratio exceeds threshold`
- diff output: `docs/acceptance/landing-page-v2/visual-drift-lower-v3.png`

## Gate

This numeric gate does not replace Product Design `design-qa`. Treat it as the visual drift meter, then run the Product Design qualitative QA gate before handoff.
