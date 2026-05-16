# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T14:50:18.915Z
- finishedAt: 2026-05-15T15:30:40.028Z
- durationMs: 2421113
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-dprime-ds.html
- provider: deepseek
- model: deepseek-v4-pro
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
| 0 | 1 | r0c0 | 7 | 50 | false | 0 |
| 1 | 1 | r1c0 | 7 | 50 | false | 0 |
| 2 | 1 | r2c0 | 7 | 48 | false | 3 |
| 3 | 1 | r3c0 | 7 | 48 | false | 3 |

## Generation (selected candidate)

- toolCount: 1
- responseCount: 0
- errorCount: 2
- generationError: Agent generation reported errors: empty artifact response from deepseek/deepseek-v4-pro: model returned no text and no tool calls for an artifact request; empty artifact response from deepseek/deepseek-v4-pro: model returned no text and no tool calls for an artifact request

Generation errors:
- empty artifact response from deepseek/deepseek-v4-pro: model returned no text and no tool calls for an artifact request
- empty artifact response from deepseek/deepseek-v4-pro: model returned no text and no tool calls for an artifact request

## Validation Failures

- bumpBlock: block not bumped/used
- gainAbility: doubleJump not acquired
- unlockGate: gate/route not unlocked
- combo: combo challenge not completed
- coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=3, passed=0, total=3。
- authored unit level1 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit level1 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=Space, frames=15, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit level1 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=Space, frames=15, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit level1 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- authored unit level2 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit level2 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=Space, frames=15, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit level2 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=Space, frames=15, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit level2 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- authored unit level3 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit level3 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=Space, frames=15, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit level3 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=Space, frames=15, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit level3 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- authored unit level3 的 reachability step 7 没有让 enemiesDefeated 满足 increase。 input=ArrowRight+Space, frames=60, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

## Runtime Smoke

- passed: false

Runtime failures:

- bumpBlock: block not bumped/used
- gainAbility: doubleJump not acquired
- unlockGate: gate/route not unlocked
- combo: combo challenge not completed
- coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=3, passed=0, total=3。
- authored unit level1 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit level1 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=Space, frames=15, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit level1 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=Space, frames=15, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit level1 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- authored unit level2 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit level2 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=Space, frames=15, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit level2 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=Space, frames=15, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit level2 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- authored unit level3 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit level3 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=Space, frames=15, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit level3 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=Space, frames=15, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit level3 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- authored unit level3 的 reachability step 7 没有让 enemiesDefeated 满足 increase。 input=ArrowRight+Space, frames=60, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

Runtime checks:

- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for authored unit level1: ArrowRight
- authored unit level1 passed reachability step 1 for player.x
- authored unit level1 passed reachability step 2 for player.y
- authored unit level1 passed reachability step 7 for enemiesDefeated
- snapshot changed after declared controls for authored unit level2: ArrowRight
- authored unit level2 passed reachability step 1 for player.x
- authored unit level2 passed reachability step 2 for player.y
- authored unit level2 passed reachability step 7 for enemiesDefeated
- snapshot changed after declared controls for authored unit level3: ArrowRight
- authored unit level3 passed reachability step 1 for player.x
- authored unit level3 passed reachability step 2 for player.y
- level1: move right increases player.x
- level1: jump changes player.y or vy negative
- stomp: enemy defeated, enemiesDefeated increased
- level2: bump block during play
- coverage included mechanics: stomp, bumpBlock
- coverage included rewards: score
- coverage included risks: fallDeath, enemyContact
- coverage included state changes: enemiesDefeated, playerVy, blocksUsed

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
