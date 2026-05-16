# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T09:23:20.245Z
- finishedAt: 2026-05-15T09:46:40.002Z
- durationMs: 1399757
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-p3.html
- provider: xiaomi
- model: mimo-v2.5-pro
- generation: gen8
- passed: false
- runtimePassed: false
- browserPassed: true

## Acceptance Loop

- bonN: 1
- repairCap: 3
- monotonicMode: warn
- escalated: true
- passedRound: N/A
- escalationReason: repair cap reached, escalate to architecture review (do not retry blindly — see docs/audits/2026-05-07-game-acceptance-architecture.md §7)

| round | candidates | selected | PASS | FAIL | fullPass | regressed |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | r0c0 | 7 | 2 | false | 0 |
| 1 | 1 | r1c0 | 7 | 2 | false | 0 |
| 2 | 1 | r2c0 | 7 | 2 | false | 0 |
| 3 | 1 | r3c0 | 7 | 2 | false | 0 |

## Generation (selected candidate)

- toolCount: 6
- responseCount: 0
- errorCount: 2
- generationError: Agent generation reported errors: empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request; empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request

Generation errors:
- empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request
- empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request

## Validation Failures

- runSmokeTest 抛出异常: levelsPassed is not defined

## Runtime Smoke

- passed: false

Runtime failures:

- runSmokeTest 抛出异常: levelsPassed is not defined

Runtime checks:

- none

## Browser Visual Smoke

- passed: true

Browser checks:

- browser visual smoke passed via system Chrome CDP
- desktop visual smoke framed 1/1 canvas element(s)
- desktop visual smoke found nonblank canvas pixels
- desktop visual smoke detected no horizontal canvas cropping
- mobile visual smoke framed 1/1 canvas element(s)
- mobile visual smoke found nonblank canvas pixels
- mobile visual smoke detected no horizontal canvas cropping

Browser failures:

- none
