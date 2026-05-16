# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T11:16:39.849Z
- finishedAt: 2026-05-15T11:35:47.646Z
- durationMs: 1147797
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-aprime-mimo.html
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
| 0 | 1 | r0c0 | 8 | 34 | false | 0 |
| 1 | 1 | r1c0 | 8 | 34 | false | 0 |
| 2 | 1 | r2c0 | 8 | 34 | false | 0 |
| 3 | 1 | r3c0 | 8 | 34 | false | 0 |

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
- 交互测试合约没有形成可平衡解析的对象字面量；请把 window.__INTERACTIVE_TEST__ / window.__GAME_TEST__ 修成一个直接赋值的平衡对象字面量，形如 window.__GAME_TEST__ = { start() {...}, reset(levelOrScenario) {...}, snapshot() {...}, step(inputState = {}, frames = 1) {...}, runSmokeTest() { return { passed, checks, failures, coverage }; } }; 不要放在注释、函数/类/IIFE/Object.assign 外壳里，也不要在对象闭合后留下重复或孤立的方法尾巴。
- reachability step 1 的 metric "player.x" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 2 的 metric "player.y" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 7 的 metric "player.x" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- comboChallenge.bump: block NOT bumped in combo
- comboChallenge.ability: doubleJump NOT gained in combo
- comboChallenge.gate: gate NOT unlocked in combo
- default start state 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight+ArrowUp, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- default start state 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=ArrowUp, frames=25, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- default start state 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=ArrowUp, frames=25, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- default start state 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=40, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

## Runtime Smoke

- passed: false

Runtime failures:

- reachability step 1 的 metric "player.x" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 2 的 metric "player.y" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- reachability step 7 的 metric "player.x" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。
- comboChallenge.bump: block NOT bumped in combo
- comboChallenge.ability: doubleJump NOT gained in combo
- comboChallenge.gate: gate NOT unlocked in combo
- default start state 的 reachability step 3 没有让 enemiesDefeated 满足 increase。 input=ArrowRight+ArrowUp, frames=30, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemiesDefeated。
- default start state 的 reachability step 4 没有让 blocksUsed 满足 increase。 input=ArrowUp, frames=25, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocksUsed。
- default start state 的 reachability step 5 没有让 abilities.doubleJump 满足 true。 input=ArrowUp, frames=25, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 abilities.doubleJump。
- default start state 的 reachability step 6 没有让 gatesUnlocked 满足 increase。 input=ArrowRight, frames=40, before=0, after=0。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gatesUnlocked。
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
- stompEnemy: enemy defeated by stomp
- stompReward: score increased after stomp
- bumpBlock: question block bumped
- gainAbility: doubleJump acquired from bump block
- abilityEffect: jumpsLeft >= 2 with doubleJump
- unlockGate: gate is unlocked with doubleJump ability
- unlockRoute: upperPath route enabled
- gatePass: player passed through gate region
- comboChallenge.stomp: enemy defeated in combo
- comboChallenge.progress: player reached upper region via combo
- coverage included mechanics: stompEnemy, bumpBlock, doubleJump, enemyPatrol, gateBlocking
- coverage included rewards: stompScore+200, coinScore+50, abilityUnlock, routeUnlock
- coverage included risks: enemyContact, fallDeath, gateBlocked
- coverage included state changes: enemiesDefeated, blocksUsed, abilities.doubleJump, gatesUnlocked, routes.upperPath, score, lives, playerX, playerY

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
