---
name: breakout
description: Breakout/Arkanoid-style brick breaker with paddle, ball, bricks, lives, and required powerups
artifact_kind: game
subtype: breakout
declared_verbs:
  - verb: moveTo
    selector: paddleX
    success: { op: change, path: paddleX }
    required: true
  - verb: traverse
    selector: ball.y
    success: { op: change, path: ball.y }
    required: true
  - verb: defeat
    selector: brickCount
    success: { op: decrease, path: brickCount }
    required: true
  - verb: collect
    selector: powerupsTriggered.length
    success: { op: increase, path: powerupsTriggered.length }
    required: true
  - verb: complete
    selector: status
    success: { op: matches, path: status, pattern: 'won|win|complete|cleared' }
    required: true
  - verb: fail
    selector: status
    success: { op: matches, path: status, pattern: 'lost|lose|failed|gameover' }
    required: true
---

# Breakout Game

Breakout/Arkanoid-style 2D brick breaker. The player moves a paddle, launches
a ball, bounces it off walls and the paddle, destroys bricks, triggers
powerups, wins when bricks are cleared, and loses when lives run out.

## Overview

Genre conventions:

- Paddle movement is input-driven; left/right controls visibly change
  `paddleX` or `paddle.x`.
- Ball launch and movement use explicit coordinates and velocity/speed fields:
  `ball.x`, `ball.y`, `ball.vx`, `ball.vy`, and/or `ball.speed`.
- Wall bounce and paddle bounce are real physics events and also increment
  explicit counters: `wallBounceCount` and `paddleBounceCount`.
- Brick hits destroy bricks, decrease `brickCount` or `bricksRemaining`, and
  increase `score`.
- Powerups are required, not optional: `wide`, `multi`, `slow`, `through`, and
  `life` must be declared, triggerable, and observable.
- Win when all bricks are cleared; lose when lives are exhausted.

Subtype identifier (`subtype: breakout`) goes in `__GAME_META__` and triggers
the `BreakoutChecker` validation pipeline at
`src/host/agent/runtime/game/breakout/BreakoutChecker.ts`.

## Generation Hints

> This section is build-time inlined into game prompt assembly so the SKILL.md
> stays a single-source-of-truth reference for breakout generation guidance.

- Translate genre/reference into mechanics, not only visual skin.
- Breakout artifacts must expose `__GAME_META__` with `subtype: 'breakout'`
  or an arkanoid-compatible subtype/genre/type value.
- Implement a playable first screen on initial page load. Before any
  `__GAME_TEST__` helper mutates state, `snapshot()` must already expose
  `brickCount`, `bricksRemaining`, or `bricks.length` greater than 0.
- Wire real browser keyboard input. A real Space keypress from the initial
  loaded start state must launch the ball and change `ball.x` or `ball.y`.
  Do not depend on `__GAME_TEST__.start()` or `reset('launch')` pre-setting an
  already launched ball.
- `snapshot()` must expose paddle movement and ball motion state:
  `paddleX` or `paddle.x`; `ball.x`, `ball.y`, and at least one of `ball.vx`,
  `ball.vy`, `ball.dx`, `ball.dy`, or `ball.speed`.
- Wall and paddle bounces need explicit runtime counters:
  `wallBounceCount` and `paddleBounceCount`.
- Brick collision must produce a visible snapshot delta: `brickCount` or
  `bricksRemaining` decreases, and `score` increases.
- Author deterministic reset scenarios with these exact quoted ids:
  `reset('paddleMove')`, `reset('launch')`, `reset('wallBounce')`,
  `reset('paddleBounce')`, `reset('brickHit')`, `reset('win')`, and
  `reset('lose')`.
- Runtime evidence should report `breakoutScenarios` probes with
  `{ name, before, after }` for every deterministic scenario. Each probe must
  be driven by live `step()`/physics, not by directly editing the after
  snapshot.
- Add a real-browser initial launch probe named `browserLaunchFromInitialLoad`
  or `browserLaunchFromStart`. Its `before` snapshot needs initial bricks and
  its `after` snapshot needs changed ball coordinates after a browser Space
  key event.
- Required powerups and reset scenarios:
  - `reset('powerup:wide')`: triggers `wide`; `paddle.width` or `paddleWidth`
    increases, or the after snapshot records the `wide` powerup.
  - `reset('powerup:multi')`: triggers `multi`; `ballCount` or `balls.length`
    increases, or the after snapshot records the `multi` powerup.
  - `reset('powerup:slow')`: triggers `slow`; `ball.speed`, `ballSpeed`, or
    `speed` decreases, or the after snapshot records the `slow` powerup.
  - `reset('powerup:through')`: triggers `through`; `through`,
    `ball.through`, `throughActive`, `powerups.through`, or
    `activePowerups.through` becomes truthy, or the after snapshot records the
    `through` powerup.
  - `reset('powerup:life')`: triggers `life`; `lives`, `player.lives`, or
    `state.lives` increases, or the after snapshot records the `life` powerup.
- Win evidence should make `status` match `won`, `win`, `complete`, or
  `cleared`; lose evidence should make `status` match `lost`, `lose`,
  `failed`, or `gameover`, or reduce lives to 0.
- Start the live game loop with `requestAnimationFrame(loop)` or an equivalent
  browser loop before the script exits, and keep the canvas/game root focusable
  so keyboard events reach the live controls.

## Repair Hints

| Failure Code | Hint |
|--------------|------|
| `breakout 缺少 paddleX 可观测状态` | Expose `paddleX` or `paddle.x` from `snapshot()`. Wire ArrowLeft/ArrowRight or left/right input so `reset('paddleMove')` followed by live `step()` changes that value. |
| `breakout 缺少 ball 坐标/速度状态` | Expose `ball.x`, `ball.y`, and velocity/speed such as `ball.vx`, `ball.vy`, `ball.dx`, `ball.dy`, or `ball.speed`. Make Space launch move ball coordinates in both `reset('launch')` and the real initial browser state. |
| `breakout 缺少 wallBounceCount` | Add `wallBounceCount` and increment it only when live ball-wall collision reverses direction. `reset('wallBounce')` should place the ball near a wall and prove `wallBounceCount > before`. |
| `breakout 缺少 paddleBounceCount` | Add `paddleBounceCount` and increment it only when the ball hits the paddle. `reset('paddleBounce')` should place the ball above the paddle and prove the counter increases. |
| `breakout 缺少 brickCount/bricksRemaining 与 score` | Expose `brickCount` or `bricksRemaining` plus `score`. `reset('brickHit')` should drive a real brick collision so brick count decreases or score increases. |
| `breakout 缺少 powerups` | Add all five required powerups: `wide`, `multi`, `slow`, `through`, and `life`. Each needs its own quoted `reset('powerup:<type>')` scenario and a matching snapshot delta. |
| `breakout 缺少 deterministic reset scenario` | Implement quoted reset ids for `paddleMove`, `launch`, `wallBounce`, `paddleBounce`, `brickHit`, `win`, `lose`, plus `powerup:wide`, `powerup:multi`, `powerup:slow`, `powerup:through`, and `powerup:life`. |
| `breakout runtime 初始首屏没有可打砖块` | Load a playable brick layout on the real initial screen. Do not create bricks only inside test-only reset scenarios. |
| `breakout runtime 缺少真实 Space 发球证据` | Normalize browser Space input from `event.code === 'Space'` or `event.key === ' '` into the same launch action used by the live loop, focus the game root on load/click, and prove ball coordinates change from initial load. |
| `breakout runtime 缺少 powerup 触发证据` | Repair each `powerup:<type>` probe so `wide` increases paddle width, `multi` increases ball count, `slow` decreases ball speed, `through` sets a truthy through flag, and `life` increases lives. |
| `breakout runtime 缺少 win 证据` | Make `reset('win')` reach `status: 'won'`, `'win'`, `'complete'`, or `'cleared'` after clearing bricks. |
| `breakout runtime 缺少 lose 证据` | Make `reset('lose')` reach `status: 'lost'`, `'lose'`, `'failed'`, or `'gameover'`, or set lives to 0 after a real miss/life-loss path. |

Other breakout-specific repair hints:

- Keep reset scenarios deterministic and short. Place ball, paddle, bricks, and
  powerups near the event under test, then drive the same live `step()` logic
  used by the playable game.
- If runtime evidence exists only in `runSmokeTest().checks`, also record
  `breakoutScenarios` probes with real before/after snapshots. The checker
  looks for named probes first for most breakout mechanics.
- If static validation passes but runtime fails, compare the exact snapshot
  paths in the failed hint against `snapshot()`. Missing aliases are enough to
  make a real mechanic invisible to validation.
- Do not fake powerup evidence with display-only labels. The checker accepts a
  typed after snapshot mention as a fallback, but robust games should expose
  the concrete state delta for each powerup.

## Snapshot Paths Reference

Breakout snapshots are expected to expose at least the following paths so
declared verbs, deterministic scenarios, and runtime probes have stable
selectors:

- Paddle: `paddleX` / `paddle.x`, plus `paddle.width` / `paddleWidth` for
  `wide`.
- Ball motion: `ball.x`, `ball.y`, `ball.vx`, `ball.vy`, `ball.dx`,
  `ball.dy`, `ball.speed`, `ballSpeed`, `speed`.
- Multi-ball: `balls`, `balls.length`, `ballCount`, `balls[0].x`,
  `balls[0].y`.
- Bounce counters: `wallBounceCount`, `paddleBounceCount`.
- Bricks / score: `brickCount`, `bricksRemaining`, `bricks.length`, `score`.
- Lives / terminal: `lives`, `player.lives`, `state.lives`, `status`, `state`,
  `mode`, `game.status`, `gameState`, `won`, `gameWon`, `levelComplete`,
  `complete`, `victory`, `lost`, `gameOver`, `failed`, `player.dead`.
- Powerups: `activePowerups`, `powerupsTriggered`,
  `powerupsTriggered.length`, `through`, `ball.through`, `throughActive`,
  `powerups.through`, `activePowerups.through`.
- Runtime observations: `observations.breakoutScenarios` or
  `observations.subtype.breakoutScenarios`, each with `name`, `before`, and
  `after`.
- Coverage names, when used as fallback: `coverage.mechanics`,
  `coverage.stateChanges`, `coverage.risks`, `coverage.allLevelsReachable`,
  `coverage.levelsPassed`, `coverage.totalLevels`.

## Reference Examples

- Static mechanics check & runtime evidence assertions:
  `src/host/agent/runtime/game/breakout/BreakoutChecker.ts`
- Repair guidance method:
  `src/host/agent/runtime/game/breakout/BreakoutChecker.ts#repairGuidance`
