# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-07T02:37:15.563Z
- finishedAt: 2026-05-07T02:37:19.388Z
- durationMs: 3825
- mode: validate-only
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-regression.html
- provider: N/A
- model: N/A
- generation: N/A
- passed: false
- runtimePassed: false
- browserPassed: true

## Generation

- N/A

## Validation Failures

- stomp enemy: enemy not defeated
- stomp enemy: score did not increase
- bump block: question block not hit
- gain ability: doubleJump not acquired
- gain ability: chest not opened
- unlock gate: gate did not open
- combo challenge: enemy not stomped
- combo challenge: score did not increase
- coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=2, passed=0, total=2。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- authored unit 0 的 reachability step 3 没有让 enemies[0].alive 满足 false。 input=ArrowRight, frames=60, before=true, after=true。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemies[0].alive。
- authored unit 0 的 reachability step 5 没有让 player.ability 满足 doubleJump。 input=ArrowRight, frames=100, before="none", after="none"。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.ability。
- authored unit 0 的 reachability step 6 没有让 gates[0].open 满足 true。 input=ArrowRight, frames=130, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gates[0].open。
- authored unit 0 的 reachability step 7 没有让 score 满足 increase。 input=ArrowRight+ArrowUp, frames=40, before=50, after=50。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 score。
- authored unit 1 的 reachability step 3 没有让 enemies[0].alive 满足 false。 input=ArrowRight, frames=60, before=true, after=true。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemies[0].alive。
- authored unit 1 的 reachability step 4 没有让 blocks[0].hit 满足 true。 input=ArrowUp, frames=20, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocks[0].hit。
- authored unit 1 的 reachability step 5 没有让 player.ability 满足 doubleJump。 input=ArrowRight, frames=100, before="none", after="none"。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.ability。
- authored unit 1 的 reachability step 6 没有让 gates[0].open 满足 true。 input=ArrowRight, frames=130, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gates[0].open。
- authored unit 1 的 reachability step 7 没有让 score 满足 increase。 input=ArrowRight+ArrowUp, frames=40, before=50, after=50。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 score。
- runSmokeTest 未通过。

## Runtime Smoke

- passed: false

Runtime failures:

- stomp enemy: enemy not defeated
- stomp enemy: score did not increase
- bump block: question block not hit
- gain ability: doubleJump not acquired
- gain ability: chest not opened
- unlock gate: gate did not open
- combo challenge: enemy not stomped
- combo challenge: score did not increase
- coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=2, passed=0, total=2。
- platformer gameplayMechanics 缺少 runtime 证据：stompable enemy 必须通过 step/runSmokeTest 让 enemy defeated 或 enemiesDefeated 增加，并证明 player bounce/vy 变化。
- authored unit 0 的 reachability step 3 没有让 enemies[0].alive 满足 false。 input=ArrowRight, frames=60, before=true, after=true。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemies[0].alive。
- authored unit 0 的 reachability step 5 没有让 player.ability 满足 doubleJump。 input=ArrowRight, frames=100, before="none", after="none"。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.ability。
- authored unit 0 的 reachability step 6 没有让 gates[0].open 满足 true。 input=ArrowRight, frames=130, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gates[0].open。
- authored unit 0 的 reachability step 7 没有让 score 满足 increase。 input=ArrowRight+ArrowUp, frames=40, before=50, after=50。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 score。
- authored unit 1 的 reachability step 3 没有让 enemies[0].alive 满足 false。 input=ArrowRight, frames=60, before=true, after=true。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 enemies[0].alive。
- authored unit 1 的 reachability step 4 没有让 blocks[0].hit 满足 true。 input=ArrowUp, frames=20, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 blocks[0].hit。
- authored unit 1 的 reachability step 5 没有让 player.ability 满足 doubleJump。 input=ArrowRight, frames=100, before="none", after="none"。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 player.ability。
- authored unit 1 的 reachability step 6 没有让 gates[0].open 满足 true。 input=ArrowRight, frames=130, before=false, after=false。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 gates[0].open。
- authored unit 1 的 reachability step 7 没有让 score 满足 increase。 input=ArrowRight+ArrowUp, frames=40, before=50, after=50。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 score。
- runSmokeTest 未通过。

Runtime checks:

- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for authored unit 0: ArrowRight
- authored unit 0 passed reachability step 1 for player.x
- authored unit 0 passed reachability step 2 for player.y
- authored unit 0 passed reachability step 4 for blocks[0].hit
- snapshot changed after declared controls for authored unit 1: ArrowRight
- authored unit 1 passed reachability step 1 for player.x
- authored unit 1 passed reachability step 2 for player.y
- bump block: score increased
- coverage included mechanics: stomp_enemy, bump_block, gain_ability, unlock_gate, combo_challenge
- coverage included rewards: score_increase_on_stomp, score_increase_on_bump, score_increase_on_ability, score_increase_on_goal
- coverage included risks: enemy_hazard, fall_death
- platformer gameplay runtime covered bumpable block evidence
- platformer gameplay runtime covered ability acquisition evidence
- platformer gameplay runtime covered ability-gated route evidence
- platformer gameplay runtime covered comboChallenge evidence

## Browser Visual Smoke

- passed: true

Browser failures:

- none
