# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T12:18:20.144Z
- finishedAt: 2026-05-15T12:37:51.379Z
- durationMs: 1171235
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-x-mimo.html
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
| 0 | 1 | r0c0 | 0 | 1 | false | 0 |
| 1 | 1 | r1c0 | 7 | 29 | false | 0 |
| 2 | 1 | r2c0 | 7 | 29 | false | 0 |
| 3 | 1 | r3c0 | 7 | 29 | false | 0 |

## Generation (selected candidate)

- toolCount: 1
- responseCount: 0
- errorCount: 2
- generationError: Agent generation reported errors: empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request; empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request

Generation errors:
- empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request
- empty artifact response from xiaomi/mimo-v2.5-pro: model returned no text and no tool calls for an artifact request

## Validation Failures

- platformer gameplayMechanics.comboChallenge 必须组合 jump，并至少再组合 stomp/enemy、block bump、ability 或 gate route 中的两类。
- reachability step 4 的 metric "player.enemiesDefeated" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 6 的 metric "player.blocksUsed" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 8 的 metric "player.gatesUnlocked" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- bumpBlock: failed to bump block
- comboChallenge: no block, no ability, no gate
- default start state 的 reachability step 5 没有让 player.x 满足 increase。 input=ArrowRight, frames=20, before=267, after=267。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 7 没有让 player.x 满足 increase。 input=ArrowRight, frames=80, before=267, after=267。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 9 没有让 player.x 满足 increase。 input=ArrowRight, frames=20, before=267, after=267。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

## Runtime Smoke

- passed: false

Runtime failures:

- reachability step 4 的 metric "player.enemiesDefeated" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 6 的 metric "player.blocksUsed" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 8 的 metric "player.gatesUnlocked" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- bumpBlock: failed to bump block
- comboChallenge: no block, no ability, no gate
- default start state 的 reachability step 5 没有让 player.x 满足 increase。 input=ArrowRight, frames=20, before=267, after=267。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 7 没有让 player.x 满足 increase。 input=ArrowRight, frames=80, before=267, after=267。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 9 没有让 player.x 满足 increase。 input=ArrowRight, frames=20, before=267, after=267。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

Runtime checks:

- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for default start state: ArrowRight
- default start state passed reachability step 1 for player.x
- default start state passed reachability step 2 for player.y
- default start state passed reachability step 3 for player.x
- stompEnemy: defeated count increased
- gainAbility: doubleJump acquired
- unlockGate: gate unlocked
- coverage included mechanics: stompEnemy, gainDoubleJump, unlockGate
- coverage included rewards: scoreFromStomp, doubleJumpFromBlock, gateUnlock
- coverage included risks: enemyContactDeath, fallOffScreenDeath
- coverage included state changes: playerPositionChanged, enemyDefeated, abilityGained, gateUnlocked

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
