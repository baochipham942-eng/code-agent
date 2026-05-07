# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-07T03:21:38.335Z
- finishedAt: 2026-05-07T03:21:43.560Z
- durationMs: 5225
- mode: validate-only
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression-openrouter-v2.html
- provider: N/A
- model: N/A
- generation: N/A
- passed: false
- runtimePassed: false
- browserPassed: true

## Generation

- N/A

## Validation Failures

- platformer gameplayMechanics 缺少 enemies 数组；平台游戏必须声明并实现 enemies、blocks、abilities、gates、comboChallenge。
- platformer gameplayMechanics 缺少 blocks 数组；平台游戏必须声明并实现 enemies、blocks、abilities、gates、comboChallenge。
- platformer gameplayMechanics 缺少 abilities 数组；平台游戏必须声明并实现 enemies、blocks、abilities、gates、comboChallenge。
- platformer gameplayMechanics 缺少 gates 数组；平台游戏必须声明并实现 enemies、blocks、abilities、gates、comboChallenge。
- platformer gameplayMechanics 缺少 comboChallenge 数组；平台游戏必须声明并实现 enemies、blocks、abilities、gates、comboChallenge。
- One or more mechanics failed validation
- coverage 没有覆盖 qualityPlan 承诺的核心玩法。
- coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。
- coverage 没有覆盖 qualityPlan 承诺的风险、敌人或失败约束。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。
- default start state 的 reachability step 1 没有让 player.x 满足 increase。 input=ArrowRight, frames=30, before=50, after=50。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 2 没有让 player.y 满足 decrease。 input=Space, frames=20, before=370, after=370。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.y。
- runSmokeTest 未通过。

## Runtime Smoke

- passed: false

Runtime failures:

- One or more mechanics failed validation
- coverage 没有覆盖 qualityPlan 承诺的核心玩法。
- coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。
- coverage 没有覆盖 qualityPlan 承诺的风险、敌人或失败约束。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。
- default start state 的 reachability step 1 没有让 player.x 满足 increase。 input=ArrowRight, frames=30, before=50, after=50。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.x。
- default start state 的 reachability step 2 没有让 player.y 满足 decrease。 input=Space, frames=20, before=370, after=370。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.y。
- runSmokeTest 未通过。

Runtime checks:

- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for default start state: ArrowRight
- Stomp Enemy: false
- Bump Block: false
- Gain Ability: false
- Unlock Gate: true
- coverage included state changes: true
- platformer gameplay runtime covered stompable enemy with defeated/bounce evidence
- platformer gameplay runtime covered bumpable block evidence
- platformer gameplay runtime covered ability acquisition evidence
- platformer gameplay runtime covered ability-gated route evidence

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
