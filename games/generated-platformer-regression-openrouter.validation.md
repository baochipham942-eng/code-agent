# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-07T03:00:02.204Z
- finishedAt: 2026-05-07T03:02:07.584Z
- durationMs: 125380
- mode: generate-and-validate
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-openrouter.html
- provider: openrouter
- model: google/gemini-3-flash-preview
- generation: gen8
- passed: false
- runtimePassed: false
- browserPassed: true

## Generation

- toolCount: N/A
- responseCount: N/A
- errorCount: 1
- generationError: Agent generation timed out after 120000ms

## Validation Failures

- platformer gameplayMechanics.comboChallenge 必须组合 jump，并至少再组合 stomp/enemy、block bump、ability 或 gate route 中的两类。
- Bump block failed
- Ability/Gate failed
- Stomp failed
- coverage 没有覆盖 qualityPlan 承诺的核心玩法。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。
- runSmokeTest 未通过。

## Runtime Smoke

- passed: false

Runtime failures:

- Bump block failed
- Ability/Gate failed
- Stomp failed
- coverage 没有覆盖 qualityPlan 承诺的核心玩法。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。
- runSmokeTest 未通过。

Runtime checks:

- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for default start state: ArrowRight
- default start state passed reachability step 1 for player.x
- default start state passed reachability step 2 for player.y
- coverage included rewards: true
- coverage included risks: true

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
