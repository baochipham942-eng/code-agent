---
name: platformer-game
description: Mario-style 2D platformer with stomp/bump/ability/gate/combo mechanics
artifact_kind: game
subtype: platformer
declared_verbs:
  - verb: defeat
    selector: enemiesDefeated
    success: { op: increase, path: enemiesDefeated }
    required: true
  - verb: collect
    selector: blocksUsed
    success: { op: increase, path: blocksUsed }
    required: true
  - verb: unlock
    selector: gatesUnlocked
    success: { op: increase, path: gatesUnlocked }
    required: true
  - verb: moveTo
    selector: player.x
    success: { op: change, path: player.x }
    required: true
  - verb: traverse
    selector: comboChallenge
    success: { op: truthy, path: coverage.comboChallenge }
    required: false
---

# Platformer Game

Mario-style 2D side-scrolling platformer. Player walks/jumps through level segments,
stomps enemies, bumps question blocks for rewards, gains rule-changing abilities
(double jump / dash / wall jump etc.), and uses those abilities to unlock gated routes.
At least one comboChallenge combines jump with two of stomp/bump/ability/gate.

## Overview

Genre conventions:

- Acceleration / friction, gravity, jump buffering or coyote time, recovery.
- Input-driven collision with platforms, hazards, rewards, and goals.
- First screen shows actor, controls, feedback, reward/risk; HUD updates score, health,
  objectives, win/fail, and progression.
- Canvas scales to viewport with `max-width` / `max-height` / `aspect-ratio` /
  `height: auto`; narrow windows must not crop the playfield.

Subtype identifier (`subtype: platformer`) goes in `__GAME_META__` and triggers the
`PlatformerChecker` validation pipeline at `src/host/agent/runtime/game/platformer/PlatformerChecker.ts`.

## Generation Hints

> This section is build-time inlined into game prompt assembly so the SKILL.md
> stays a single-source-of-truth reference for platformer generation guidance.

- Translate genre/reference into mechanics, not only visual skin.
- Platformers must include acceleration/friction, gravity, jump buffering or coyote
  time, recovery, and input-driven collision with platforms, hazards, rewards, and goals.
- Gameplay Mechanics Contract: implement a stompable enemy, a bumpable/question block,
  a movement/interaction-changing ability, an ability-gated route, and one
  comboChallenge that combines jump with at least two of enemy/block/ability/gate play.
- For subtype `platformer`, use exact shape
  `gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] }`;
  each field is an array even when it has one item, never an object map.
- Fill `stompable`/`defeatReward`, `bumpableFromBelow`/`reward`/`usedState`,
  `acquiredFrom`/`effect`/`unlocksRoute`, `requiresAbility`/`blocksAccessTo`,
  `requires`/`target`. Use `doubleJump`, `dash`, `shield`, `magnet`, `groundPound`,
  or `wallJump`.
- For movement metrics like `player.x`, `player.y`, `player.vx`, `player.vy`, the
  `expect` MUST be one of `"increase"` / `"decrease"` / `"change"`, never a numeric
  target. A numeric or boolean expect means exact final equality after the declared
  frames, only valid for counters like `enemiesDefeated` / `blocksUsed` /
  `gatesUnlocked` or boolean flags like `abilities.doubleJump`.
- Reachability steps must be short, deterministic, and locally true: use real snapshot
  paths such as `player.x`, `player.vy`, `enemiesDefeated`, `blocksUsed`,
  `abilities.doubleJump`, `gatesUnlocked`, `routesUnlocked`; do not expect
  score/progress/win/gate/ability changes unless that exact input window triggers
  live collision.
- For platformers, nearby authored smoke scenarios like `reset('stomp')`,
  `reset('bumpBlock')`, `reset('gainAbility')`, and `reset('unlockGate')` are better
  than long full-level treks, but they must still use live physics/collision.
- For platformers, `runSmokeTest()` proves gameplayMechanics with before/after
  snapshots: stomp enemy defeated plus player bounce/vy, bump block
  used/spawnedReward, ability changes, gate/route reachability after ability, and
  comboChallenge sequence.

## Repair Hints

| Failure Code | Hint |
|--------------|------|
| `missing_gameplay_mechanics` | Add `gameplayMechanics` to `__GAME_META__` with `enemies`, `blocks`, `abilities`, `gates`, `comboChallenge` (each an array, never a map). Implement collision: stomp marks enemy defeated and bounces `player.vy`; bump marks block used and spawns the ability; ability changes movement; gate checks ability before route access. |
| `gameplay_mechanics_without_runtime_evidence` | Repair `runSmokeTest()` so it drives `step()` through stomp enemy, bump block, gain ability, unlock gate/route, and combo challenge — record coverage only after before/after snapshot changes prove each mechanic. |
| `ability_gate_without_reachability` | Make one ability change movement or interaction rules and unlock a real gated route. `snapshot()` should expose `abilities` and gate/route state, and `runSmokeTest()` must prove ability `false → true` followed by gate/route `unreachable → reachable`. |

Other platformer-specific repair hints:

- For platformers, add/repair `gameplayMechanics` with enemies, blocks, abilities,
  gates, and comboChallenge, wired to real `step()` gameplay and `runSmokeTest()`
  before/after snapshot evidence.
- Platformer `gameplayMechanics.enemies`, `blocks`, `abilities`, `gates`, and
  `comboChallenge` must be arrays; do not repair them as `{ enemies: { ... } }` or
  keyed object maps.
- If the full level path is too long, repair platformers with deterministic authored
  scenarios for stomp, bumpBlock, gainAbility, unlockGate, and comboChallenge using
  the live rules.
- Platformer coverage must prove `stompEnemy`, `bumpBlock`, `gainAbility`,
  `unlockGate`/`routeReachableAfterAbility`, and `comboChallenge`, with stateChanges
  for `enemiesDefeated`, `player.vy`/bounce, `blocksUsed`/`spawnedReward`,
  `abilities`, and `gates`/`routes`.

## Snapshot Paths Reference

Platformer snapshots are expected to expose at least the following paths so
`progressPlan` / `reachability` and `runSmokeTest()` coverage have stable selectors:

- Position / motion: `player.x`, `player.y`, `player.vx`, `player.vy`
- Combat counters: `enemiesDefeated` / `defeatedEnemies` (also matches
  `stompedEnemies`, `stomps`)
- Block interaction: `blocksUsed` / `blocksBumped` / `blockHits` / `spawnedRewards`
- Abilities: `abilities.doubleJump`, `abilities.dash`, `abilities.shield`,
  `abilities.magnet`, `abilities.groundPound`, `abilities.wallJump`,
  or under `player.abilities.*`
- Gates / routes: `gatesUnlocked` / `routesUnlocked` / `reachableTargets`,
  or `gates.<id>.{open,unlocked,reachable}`
- Coverage names (returned from `runSmokeTest().coverage`):
  `coverage.mechanics`, `coverage.rewards`, `coverage.risks`,
  `coverage.stateChanges`, `coverage.gameplayMechanics`,
  `coverage.mechanicsEvidence`, `coverage.allLevelsReachable`

## Reference Examples

- Static mechanics check & runtime evidence assertions:
  `src/host/agent/runtime/game/platformer/PlatformerChecker.ts`
- Repair codes (failure pattern → hint):
  `src/host/agent/runtime/game/platformer/repairCodes.ts`
- Architecture audit & migration plan:
  `docs/audits/2026-05-07-game-acceptance-architecture.md` §5–§6
