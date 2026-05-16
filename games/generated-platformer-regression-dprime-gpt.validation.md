# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T14:31:52.493Z
- finishedAt: 2026-05-15T14:32:06.702Z
- durationMs: 14209
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-dprime-gpt.html
- provider: openai
- model: gpt-5.4
- generation: gen8
- passed: false
- runtimePassed: N/A
- browserPassed: N/A

## Acceptance Loop

- bonN: 1
- repairCap: 3
- monotonicMode: warn
- escalated: true
- passedRound: N/A
- escalationReason: repair cap reached, escalate to architecture review (do not retry blindly — see docs/audits/2026-05-07-game-acceptance-architecture.md §7)

| round | candidates | selected | PASS | FAIL | fullPass | regressed |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | r0c0 | 0 | 1 | false | 0 |
| 1 | 1 | r1c0 | 0 | 1 | false | 0 |
| 2 | 1 | r2c0 | 0 | 1 | false | 0 |
| 3 | 1 | r3c0 | 0 | 1 | false | 0 |

## Generation (selected candidate)

- toolCount: 0
- responseCount: 0
- errorCount: 2
- generationError: Agent generation reported errors: OpenAI API 错误 (403); OpenAI API 错误 (403)

Generation errors:
- OpenAI API 错误 (403)
- OpenAI API 错误 (403)

## Validation Failures

- Artifact was not written; generation failed: Agent generation reported errors: OpenAI API 错误 (403); OpenAI API 错误 (403)

## Runtime Smoke

- passed: N/A

Runtime failures:

- none

Runtime checks:

- none

## Browser Visual Smoke

- passed: N/A

Browser checks:

- none

Browser failures:

- none
