# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-15T08:07:51.643Z
- finishedAt: 2026-05-15T08:07:57.331Z
- durationMs: 5688
- mode: validate-only
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/ds-prompt-test.html
- provider: N/A
- model: N/A
- generation: N/A
- passed: false
- runtimePassed: false
- browserPassed: true

## Generation (selected candidate)

- N/A

## Validation Failures

- reachability step 1 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- reachability step 2 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- reachability step 3 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- reachability step 4 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- stomp_enemy: enemiesDefeated or player.vy did not change
- bump_block: blocksUsed or abilities.doubleJump did not change correctly
- gain_ability: doubleJump not acquired
- unlock_gate: gate1 not unlocked
- combo_challenge: missing prerequisite evidence
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

## Runtime Smoke

- passed: false

Runtime failures:

- reachability step 1 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- reachability step 2 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- reachability step 3 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- reachability step 4 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。
- stomp_enemy: enemiesDefeated or player.vy did not change
- bump_block: blocksUsed or abilities.doubleJump did not change correctly
- gain_ability: doubleJump not acquired
- unlock_gate: gate1 not unlocked
- combo_challenge: missing prerequisite evidence
- runSmokeTest 未通过。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- platformer gameplayMechanics 缺少 runtime 证据：ability 必须通过真实输入获得，并让 snapshot().abilities 或 snapshot().player.abilities 发生变化。
- platformer gameplayMechanics 缺少 runtime 证据：gate 必须在获得技能后改变 unlocked/open/reachable route 或 reachableTarget 状态。
- platformer gameplayMechanics 缺少 runtime 证据：comboChallenge coverage 必须证明 jump 加 stomp/block/ability/gate 中至少两类的组合挑战。

Runtime checks:

- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for default start state: jump

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
