# Platformer Gameplay Acceptance Report

- startedAt: 2026-06-11T13:37:34.813Z
- finishedAt: 2026-06-11T13:37:51.779Z
- durationMs: 16966
- mode: validate-only
- artifactPath: /Users/linchen/Downloads/ai/code-agent/.claude/worktrees/game-gen-codex-style/games/generated-platformer-codex-mimo.html
- provider: N/A
- model: N/A
- strategy: N/A
- passed: false
- runtimePassed: false
- browserPassed: false

## Product Status

- status: PLAYABLE_QUALITY_GAP
- summary: 游戏已生成，但玩法验收未达标。
- visibleState: 文件已生成，但首屏呈现和玩法闭环还需要一起补。
- diagnosticsCount: 23

Repair focus:

- 补玩法闭环：让移动、敌人、方块、能力、路线或通关路径由真实输入触发。
- 补验收证据：让 metadata、snapshot、progressPlan 和 runSmokeTest 对齐真实状态。
- 补首屏质量：让角色、HUD、奖励、风险和目标在桌面与移动视口都可见。

## Generation (selected candidate)

- N/A

## Diagnostic Details

<details>
<summary>Raw validator details</summary>

### Validation Detail

- runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据；这不能证明玩家实际触发了奖励、风险或机制。请用前后 snapshot 的真实状态变化证明承诺的交互。
- jump: player did not jump
- coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。
- default start state 的 reachability step 4 没有让 player.y 满足 decrease。 input=ArrowRight, frames=90, before=367.3, after=452。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.y。
- default start state 的 reachability step 5 没有让 lives 满足 decrease。 input=ArrowRight, frames=120, before=3, after=3。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 lives。
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：bumpable/question block 必须通过 step/runSmokeTest 变成 used/broken/bumped，或产生 spawnedReward。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。
- 无法运行 browser visual smoke: Timed out waiting for Chrome CDP endpoint on port 52554: fetch failed

### Runtime Smoke

- passed: false

Runtime failures:

- jump: player did not jump
- coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。
- default start state 的 reachability step 4 没有让 player.y 满足 decrease。 input=ArrowRight, frames=90, before=367.3, after=452。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.y。
- default start state 的 reachability step 5 没有让 lives 满足 decrease。 input=ArrowRight, frames=120, before=3, after=3。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 lives。
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
- default start state passed reachability step 2 for player.x
- default start state passed reachability step 3 for player.vy
- default start state passed reachability step 6 for levelComplete
- moveRight: player moved right
- moveLeft: player moved left
- platformLand: player stayed on/near platform level (y=452)
- fallDeath: player lost a life or game over
- win: reached goal, level complete
- scoreBaseline: score starts at 0
- snapshotComplete: all required metric paths present
- coverage included mechanics: moveRight, moveLeft, platformLand
- coverage included risks: fallDeath
- coverage included state changes: playerMoved, statusChanged

### Browser Visual Smoke

- passed: false

Browser checks:

- none

Browser failures:

- 无法运行 browser visual smoke: Timed out waiting for Chrome CDP endpoint on port 52554: fetch failed

</details>
