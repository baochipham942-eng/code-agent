# Platformer Gameplay Acceptance Report

- startedAt: 2026-05-07T03:26:29.794Z
- finishedAt: 2026-05-07T03:26:33.034Z
- durationMs: 3240
- mode: validate-only
- artifactPath: /Users/linchen/Downloads/ai/code-agent/games/generated-platformer-mechanics.html
- provider: N/A
- model: N/A
- generation: N/A
- passed: true
- runtimePassed: true
- browserPassed: true

## Generation

- N/A

## Validation Failures

- none

## Runtime Smoke

- passed: true

Runtime failures:

- none

Runtime checks:

- runtime smoke passed via interactive test contract
- interactive contract exposes step(inputState, frames)
- interactive contract exposes reset(levelOrScenario)
- snapshot changed after declared controls for default start state: ArrowRight
- default start state passed reachability step 1 for player.x
- default start state passed reachability step 2 for player.vy
- default start state passed reachability step 3 for player.x
- bumpBlock gained doubleJump from question block
- stompEnemy defeated slime and bounced player.vy
- unlockGate opened ability-gated upper route
- coverage included mechanics: bumpBlock, gainAbility, doubleJump, stompEnemy, unlockGate, gateRoute, comboChallenge
- coverage included rewards: blockAbility, defeatReward
- coverage included risks: enemyCollision, lockedGate
- coverage included state changes: blocksUsed, spawnedReward, abilities.doubleJump, enemiesDefeated, score, player.vy, gatesUnlocked, routesUnlocked, reachableTargets, routeReachableAfterAbility, comboChallengeComplete
- platformer gameplay runtime covered stompable enemy with defeated/bounce evidence
- platformer gameplay runtime covered bumpable block evidence
- platformer gameplay runtime covered ability acquisition evidence
- platformer gameplay runtime covered ability-gated route evidence
- platformer gameplay runtime covered comboChallenge evidence

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
