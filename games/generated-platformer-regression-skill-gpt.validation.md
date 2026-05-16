# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T13:26:41.207Z
- finishedAt: 2026-05-15T13:56:38.727Z
- durationMs: 1797520
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-skill-gpt.html
- provider: openai
- model: gpt-5.4
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
| 0 | 1 | r0c0 | 7 | 38 | false | 0 |
| 1 | 1 | r1c0 | 7 | 38 | false | 0 |
| 2 | 1 | r2c0 | 7 | 38 | false | 0 |
| 3 | 1 | r3c0 | 7 | 38 | false | 0 |

## Generation (selected candidate)

- toolCount: 4
- responseCount: 1
- errorCount: 0

## Validation Failures

- 缺少可用于验收的关卡、片段、场景或目标元数据；工程层不能只凭源码猜游戏是否完整。
- 缺少 controls 元数据；工程层不知道该模拟什么输入来验证真实可操作性。
- 缺少 reachability/acceptance/progressPlan/validation 元数据；工程层无法验证目标、场景或关卡能被推进。
- 缺少 qualityPlan/acceptance 级别的玩法承诺元数据；工程层无法判断角色可辨识、奖励/风险是否真实存在。
- gain ability failed
- combo challenge failed
- coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=2, passed=2, total=2。
- authored unit meadow-run 的 reachability step 3 没有让 enemiesDefeated 满足 1。 input=ArrowRight+Space, frames=34, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit meadow-run 的 reachability step 4 没有让 blocksUsed 满足 1。 input=Space, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit meadow-run 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=ArrowRight+Space, frames=28, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit meadow-run 的 reachability step 6 没有让 routesUnlocked 满足 1。 input=ArrowRight+Space, frames=50, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 routesUnlocked。
- authored unit sky-gate 的 reachability step 3 没有让 enemiesDefeated 满足 1。 input=ArrowRight+Space, frames=34, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit sky-gate 的 reachability step 4 没有让 blocksUsed 满足 1。 input=Space, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit sky-gate 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=ArrowRight+Space, frames=28, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit sky-gate 的 reachability step 6 没有让 routesUnlocked 满足 1。 input=ArrowRight+Space, frames=50, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 routesUnlocked。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

## Runtime Smoke

- passed: false

Runtime failures:

- gain ability failed
- combo challenge failed
- coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=2, passed=2, total=2。
- authored unit meadow-run 的 reachability step 3 没有让 enemiesDefeated 满足 1。 input=ArrowRight+Space, frames=34, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit meadow-run 的 reachability step 4 没有让 blocksUsed 满足 1。 input=Space, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit meadow-run 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=ArrowRight+Space, frames=28, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit meadow-run 的 reachability step 6 没有让 routesUnlocked 满足 1。 input=ArrowRight+Space, frames=50, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 routesUnlocked。
- authored unit sky-gate 的 reachability step 3 没有让 enemiesDefeated 满足 1。 input=ArrowRight+Space, frames=34, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- authored unit sky-gate 的 reachability step 4 没有让 blocksUsed 满足 1。 input=Space, frames=20, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- authored unit sky-gate 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=ArrowRight+Space, frames=28, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- authored unit sky-gate 的 reachability step 6 没有让 routesUnlocked 满足 1。 input=ArrowRight+Space, frames=50, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 routesUnlocked。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

Runtime checks:

- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for authored unit meadow-run: ArrowRight
- authored unit meadow-run passed reachability step 1 for player.x
- authored unit meadow-run passed reachability step 2 for player.y
- snapshot changed after declared controls for authored unit sky-gate: ArrowRight
- authored unit sky-gate passed reachability step 1 for player.x
- authored unit sky-gate passed reachability step 2 for player.y
- stomp enemy
- bump block
- unlock gate route
- coverage included mechanics: stompEnemy, bumpBlock, abilityGatedRoute
- coverage included rewards: scoreFromStomp, spawnPickup
- coverage included risks: pitFallStatePresent
- coverage included state changes: enemiesDefeated, blocksUsed, routesUnlocked

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
