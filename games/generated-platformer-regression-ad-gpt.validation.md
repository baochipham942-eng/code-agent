# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T14:02:24.731Z
- finishedAt: 2026-05-15T14:23:53.245Z
- durationMs: 1288514
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-ad-gpt.html
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
| 0 | 1 | r0c0 | 21 | 16 | false | 0 |
| 1 | 1 | r1c0 | 21 | 16 | false | 0 |
| 2 | 1 | r2c0 | 21 | 16 | false | 0 |
| 3 | 1 | r3c0 | 21 | 16 | false | 0 |

## Generation (selected candidate)

- toolCount: 0
- responseCount: 0
- errorCount: 2
- generationError: Agent generation reported errors: OpenAI API error: 403 - {"error":{"message":"insufficient balance","type":"billing_error"}}; OpenAI API error: 403 - {"error":{"message":"insufficient balance","type":"billing_error"}}

Generation errors:
- OpenAI API error: 403 - {"error":{"message":"insufficient balance","type":"billing_error"}}
- OpenAI API error: 403 - {"error":{"message":"insufficient balance","type":"billing_error"}}

## Validation Failures

- combo step 3: stomp enemy failed
- combo step 4: gate unlock or combo completion failed
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

## Runtime Smoke

- passed: false

Runtime failures:

- combo step 3: stomp enemy failed
- combo step 4: gate unlock or combo completion failed
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
- default start state passed reachability step 4 for player.y
- default start state passed reachability step 5 for player.x
- default start state passed reachability step 6 for player.y
- move right increases player.x
- jump input changes player.y
- stomp defeats enemy and bounces player
- bump block marks used state and spawns reward
- ability pickup grants double jump
- ability unlocks gate route
- combo step 1: bump block
- combo step 2: collect ability
- risk path remains live in authored level
- coverage included mechanics: horizontalMovement, jumpArc, enemyStomp, bumpBlock, abilityPickup, gateUnlock
- coverage included rewards: stompScore, blockReward, abilityReward
- coverage included risks: enemyContact, hazardRisk
- coverage included state changes: player.x, player.y, enemiesDefeated, player.vy, blocksUsed, rewardsSpawned, abilities.doubleJump, pickupsCollected, gatesUnlocked, gateOpen, blocksUsed, abilities.doubleJump, pickupsCollected, hazardsTouched

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
