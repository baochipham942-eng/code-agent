---
name: runner-game
description: Endless runner — auto-running player dodges obstacles and collects pickups while distance increases
artifact_kind: game
subtype: runner
declared_verbs:
  - verb: moveTo
    selector: distanceTraveled
    success: { op: increase, path: distanceTraveled }
    required: true
  - verb: evade
    selector: obstaclesAvoided
    success: { op: increase, path: obstaclesAvoided }
    required: true
  - verb: collect
    selector: pickupsCollected
    success: { op: increase, path: pickupsCollected }
    required: false
  - verb: complete
    selector: distanceTraveled
    success: { op: increase, path: distanceTraveled }
    required: true
  - verb: fail
    selector: gameOver
    success: { op: truthy, path: gameOver }
    required: false
---

# Runner Game

## Overview

2D endless runner: auto-running character dodges obstacles, collects pickups, dies on
collision. Distance is the score. No level progression — survival as long as possible.

Subtype identifier (`subtype: runner`) goes in `__GAME_META__` and triggers the
`RunnerChecker` validation pipeline at
`src/host/agent/runtime/game/runner/RunnerChecker.ts`.

Genre conventions:

- Forward motion is **automatic** — the player never presses a "go forward" key.
  Time-step itself is the implicit input; `step()` integrates `runSpeed * frames`
  into `distanceTraveled` regardless of the input string.
- Player input is reactive only: jump (Space), slide (ArrowDown), optional lane
  swap (ArrowLeft / ArrowRight).
- Obstacles spawn at known positions along the forward axis; each obstacle
  declares an `action` (jump / slide / swap-lane) so generation and smoke tests
  agree on the required input.
- Death is the only terminal: hitting an unhandled obstacle sets `gameOver: true`.
  HUD shows distance, pickups, optional best-distance.

## Generation Hints

- Player auto-moves along `forwardAxis` ("x" for horizontal runner, "y" for
  vertical). No left/right input drives forward motion.
- Controls: `jump = Space`, `slide = ArrowDown`. Optional: `laneLeft = ArrowLeft`,
  `laneRight = ArrowRight`.
- `__GAME_META__` shape:
  - `subtype: 'runner'`
  - `autoRun: true`
  - `forwardAxis: 'x'` (or `'y'`)
  - `runSpeed: <number>` (units per frame; integrate every step)
  - `obstacles: [{ id, type, position, action }]` — each entry mandatory
  - `pickups: [{ id, type, position, value }]` — optional but recommended
- `snapshot()` MUST expose: `{ player: { x, y, vy }, distanceTraveled,
  obstaclesAvoided, pickupsCollected, gameOver, score, status }`.
- `progressPlan` example:
  ```json
  [
    { "label": "auto-run", "input": "", "frames": 24, "metric": "distanceTraveled", "expect": "increase" },
    { "label": "jump dodge", "input": "Space", "frames": 12, "metric": "obstaclesAvoided", "expect": "increase" },
    { "label": "slide dodge", "input": "ArrowDown", "frames": 12, "metric": "obstaclesAvoided", "expect": "increase" }
  ]
  ```
- For movement metrics like `player.x`, `distanceTraveled`, `obstaclesAvoided`,
  `pickupsCollected`, `expect` MUST be one of `"increase"` / `"decrease"` /
  `"change"`, never a numeric target. Boolean expects (e.g. `gameOver: true`)
  are valid for terminal flags.

### Empty input for auto-run mechanics

Runner is the first genre with **legitimate empty / "none" input** in
`progressPlan`. The platformer validator currently rejects this because
platformer forward motion comes from ArrowRight presses; runner forward motion
comes from the time-step itself.

When generating a runner, declare the auto-run probe with `input: ""` (empty
string) — the validator should accept it for runner subtype because
`autoRun: true` in metadata makes forward motion implicit. If the validator
infrastructure rejects empty inputs uniformly, that's a gap to surface — runner
needs the validator to consult `subtype` before enforcing the "input must come
from controls" rule. **Do not** work around it by emitting bogus inputs like
`"ArrowRight"` for a game that ignores ArrowRight; that masks the architectural
gap and produces fake evidence.

### Smoke test contract

`runSmokeTest()` must drive `step()` and prove:

1. **Auto-run**: `step("", 24)` → assert `after.distanceTraveled > before.distanceTraveled`.
2. **Obstacle dodge**: `step("Space", 12)` over a jump-action obstacle → assert
   `after.obstaclesAvoided > before.obstaclesAvoided`.
3. **Pickup collect** (if pickups declared): `step("", N)` past a pickup
   → assert `after.pickupsCollected > before.pickupsCollected`.
4. **Death** (optional): drive into an unhandled obstacle → assert
   `after.gameOver === true`.

Coverage names returned by `runSmokeTest().coverage`:
`coverage.mechanics = ["autoRun", "dodgeJump", "dodgeSlide", "collect"]`,
`coverage.stateChanges = ["distanceTraveled", "obstaclesAvoided", "pickupsCollected", "gameOver"]`.

## Repair Hints

| Failure Code | Hint |
|--------------|------|
| `missing_runner_loop_metadata` | Declare `__GAME_META__.autoRun = true` plus `forwardAxis` ("x" or "y") and `runSpeed`. `step()` must increment `distanceTraveled` even with empty input — forward motion is implicit from the time-step. |
| `missing_obstacle_metadata` | Add `__GAME_META__.obstacles = [{ id, type, position, action }]` with at least one entry. The `action` field tells the player how to dodge (jump / slide / swap-lane). Hitting an unhandled obstacle should set `gameOver: true`. |
| `runner_no_distance_progression` | Make `step()` unconditionally advance `distanceTraveled` by `runSpeed * frames` (or per-frame integration) regardless of input. `runSmokeTest()` must take a before snapshot, call `step("", N)` with empty input, take an after snapshot, and assert `after.distanceTraveled > before.distanceTraveled`. |

Other runner-specific repair hints:

- If your engine ties forward motion to keyboard handling (e.g. ArrowRight
  increments `player.x`), refactor: forward speed should come from a `runSpeed`
  constant integrated each frame, not from input handling. Input should only
  control jump / slide / lane.
- If smoke says "distance not increasing", the most common cause is that
  `step()` early-returns on empty input. Remove that guard.
- If `obstaclesAvoided` doesn't increment, check that the obstacle's `action`
  field matches the input you're driving (Space for jump, ArrowDown for slide).

## Snapshot Paths Reference

Runner snapshots are expected to expose at least the following paths:

- Position / motion: `player.x`, `player.y`, `player.vy`
- Progress (monotonic): `distanceTraveled` (number, increases every step)
- Dodge counter: `obstaclesAvoided` (number, increments on successful dodge)
- Pickup counter: `pickupsCollected` (number)
- Terminal: `gameOver` (boolean)
- Score / status: `score`, `status` (e.g. `'running' | 'over'`)
- Coverage names: `coverage.mechanics`, `coverage.stateChanges`,
  `coverage.gameplayMechanics`, `coverage.mechanicsEvidence`

## Reference Examples

- Static mechanics check & runtime evidence assertions:
  `src/host/agent/runtime/game/runner/RunnerChecker.ts`
- Repair codes (failure pattern → hint):
  `src/host/agent/runtime/game/runner/repairCodes.ts`
- Architecture audit & migration plan:
  `docs/audits/2026-05-07-game-acceptance-architecture.md` §4.4 (runner column)
