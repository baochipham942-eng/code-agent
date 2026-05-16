# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T08:18:58.284Z
- finishedAt: 2026-05-15T08:27:12.045Z
- durationMs: 493761
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-mimo.html
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
| 1 | 1 | r1c0 | 23 | 25 | false | 0 |
| 2 | 1 | r2c0 | 7 | 3 | false | 28 |
| 3 | 1 | r3c0 | 7 | 45 | false | 25 |

## Generation (selected candidate)

- toolCount: N/A
- responseCount: N/A
- errorCount: 1
- generationError: Agent generation timed out after 120000ms

## Validation Failures

- platformer gameplayMechanics.comboChallenge 必须组合 jump，并至少再组合 stomp/enemy、block bump、ability 或 gate route 中的两类。
- reachability step 7 的 metric "abilities.doubleJump" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- stomp_enemy: enemiesDefeated did not increase
- bump_block: blocksUsed did not increase
- gain_ability: doubleJump is still false
- unlock_gate: gatesUnlocked did not increase
- comboChallenge: block bump not achieved
- comboChallenge: ability not gained
- comboChallenge: gate not unlocked
- doubleJump_highPlatform: did not reach high platform
- default start state 的 reachability step 4 没有让 enemiesDefeated 满足 increase。 input=ArrowRight+Space, frames=30, before=1, after=1。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- default start state 的 reachability step 6 没有让 blocksUsed 满足 increase。 input=Space, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- default start state 的 reachability step 8 没有让 player.x 满足 increase。 input=ArrowRight, frames=120, before=1496, after=1496。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 9 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=10, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- default start state 的 reachability step 10 没有让 player.x 满足 increase。 input=ArrowRight+Space, frames=30, before=1496, after=1496。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 11 没有让 player.y 满足 decrease。 input=ArrowRight+Space, frames=40, before=414.20000000000005, after=414.20000000000005。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.y。
- default start state 的 reachability step 12 没有让 score 满足 increase。 input=ArrowRight, frames=60, before=200, after=200。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 score。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

## Runtime Smoke

- passed: false

Runtime failures:

- reachability step 7 的 metric "abilities.doubleJump" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- stomp_enemy: enemiesDefeated did not increase
- bump_block: blocksUsed did not increase
- gain_ability: doubleJump is still false
- unlock_gate: gatesUnlocked did not increase
- comboChallenge: block bump not achieved
- comboChallenge: ability not gained
- comboChallenge: gate not unlocked
- doubleJump_highPlatform: did not reach high platform
- default start state 的 reachability step 4 没有让 enemiesDefeated 满足 increase。 input=ArrowRight+Space, frames=30, before=1, after=1。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- default start state 的 reachability step 6 没有让 blocksUsed 满足 increase。 input=Space, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- default start state 的 reachability step 8 没有让 player.x 满足 increase。 input=ArrowRight, frames=120, before=1496, after=1496。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 9 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=10, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- default start state 的 reachability step 10 没有让 player.x 满足 increase。 input=ArrowRight+Space, frames=30, before=1496, after=1496。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 11 没有让 player.y 满足 decrease。 input=ArrowRight+Space, frames=40, before=414.20000000000005, after=414.20000000000005。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.y。
- default start state 的 reachability step 12 没有让 score 满足 increase。 input=ArrowRight, frames=60, before=200, after=200。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 score。
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
- default start state passed reachability step 5 for player.x
- move_right: player.x increased
- jump: player.y changed / vy negative
- comboChallenge: stomp in combo
- coverage included mechanics: move, jump, doubleJump, stomp, bumpBlock, gateUnlock, patrol, gravity, friction, collision
- coverage included rewards: coin, doubleJump, enemyScore, goalScore
- coverage included risks: enemyDamage, fallOffMap, healthLoss
- coverage included state changes: playerMoved

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
