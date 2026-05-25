import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { validateGameArtifact } from '../../../src/main/agent/runtime/gameArtifactValidator';

async function writeFixture(content: string, filename: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-breakout-validator-'));
  const filePath = path.join(dir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

function breakoutFixture(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Breakout Contract Fixture</title>
  <style>
    html, body { margin: 0; min-height: 100%; }
    body { display: grid; place-items: center; }
    canvas { width: min(100vw - 16px, 800px); max-height: calc(100dvh - 16px); aspect-ratio: 4 / 3; height: auto; background: #111; }
  </style>
</head>
<body>
  <canvas id="game" width="800" height="600"></canvas>
  <script>
    const scenarios = [
      { id: 'paddleMove' },
      { id: 'launch' },
      { id: 'wallBounce' },
      { id: 'paddleBounce' },
      { id: 'brickHit' },
      { id: 'powerup:wide' },
      { id: 'powerup:multi' },
      { id: 'powerup:slow' },
      { id: 'powerup:through' },
      { id: 'powerup:life' },
      { id: 'win' },
      { id: 'lose' }
    ];
    window.__GAME_META__ = {
      domain: 'game',
      subtype: 'arkanoid',
      controls: { left: 'ArrowLeft', right: 'ArrowRight', launch: 'Space' },
      coreLoop: 'move paddle, launch ball, break bricks, catch powerups, win or lose',
      objectives: scenarios,
      scenarios,
      win: 'clear all bricks',
      fail: 'lose all lives',
      qualityPlan: {
        actorReadable: true,
        mechanics: ['paddle', 'launch', 'wallBounce', 'paddleBounce', 'brickHit'],
        rewards: ['wide', 'multi', 'slow', 'through', 'life'],
        risks: ['missedBall', 'lose'],
        levelsCovered: 12,
        allAuthoredLevelsReachable: true
      },
      progressPlan: [
        { label: 'move paddle', input: 'ArrowRight', frames: 12, metric: 'paddleX', expect: 'increase' },
        { label: 'launch ball', input: 'Space', frames: 12, metric: 'ball.x', expect: 'change' }
      ],
      powerups: ['wide', 'multi', 'slow', 'through', 'life']
    };

    let state;
    const browserInput = {};
    function baseState(scenario = 'default') {
      return {
        scenario,
        paddleX: 80,
        paddle: { x: 80, width: 80 },
        ball: { x: 120, y: 420, vx: 3, vy: -3, speed: 6, through: false },
        balls: [{ x: 120, y: 420 }],
        brickCount: 8,
        bricksRemaining: 8,
        score: 0,
        wallBounceCount: 0,
        paddleBounceCount: 0,
        lives: scenario === 'powerup:life' ? 1 : 3,
        status: 'playing',
        activePowerups: {},
        powerupsTriggered: []
      };
    }
    function applyPowerup(type) {
      state.activePowerups[type] = true;
      state.powerupsTriggered.push(type);
      if (type === 'wide') state.paddle.width += 40;
      if (type === 'multi') state.balls.push({ x: state.ball.x + 4, y: state.ball.y });
      if (type === 'slow') state.ball.speed -= 2;
      if (type === 'through') state.ball.through = true;
      if (type === 'life') state.lives += 1;
    }
    function tick(input = {}) {
      if (input.ArrowRight || input.right) {
        state.paddleX += 12;
        state.paddle.x = state.paddleX;
      }
      if (input.ArrowLeft || input.left) {
        state.paddleX -= 12;
        state.paddle.x = state.paddleX;
      }
      if (input.Space || input.launch) {
        state.ball.x += state.ball.vx;
        state.ball.y += state.ball.vy;
      }
      if (state.scenario === 'wallBounce') state.wallBounceCount += 1;
      if (state.scenario === 'paddleBounce') state.paddleBounceCount += 1;
      if (state.scenario === 'brickHit') {
        state.brickCount -= 1;
        state.bricksRemaining -= 1;
        state.score += 100;
      }
      if (state.scenario.startsWith('powerup:')) applyPowerup(state.scenario.slice('powerup:'.length));
      if (state.scenario === 'win') state.status = 'won';
      if (state.scenario === 'lose') {
        state.status = 'lost';
        state.lives = 0;
      }
    }
    function snapshot() {
      return JSON.parse(JSON.stringify({
        scenario: state.scenario,
        paddleX: state.paddleX,
        paddle: state.paddle,
        ball: state.ball,
        balls: state.balls,
        brickCount: state.brickCount,
        bricksRemaining: state.bricksRemaining,
        score: state.score,
        wallBounceCount: state.wallBounceCount,
        paddleBounceCount: state.paddleBounceCount,
        lives: state.lives,
        status: state.status,
        activePowerups: state.activePowerups,
        powerupsTriggered: state.powerupsTriggered
      }));
    }
    function runScenario(name, input, frames) {
      window.__GAME_TEST__.reset(name);
      const before = snapshot();
      window.__GAME_TEST__.step(input, frames);
      const after = snapshot();
      return { before, after };
    }
    window.__GAME_TEST__ = {
      start() { state = baseState('default'); },
      reset(levelOrScenario = 'default') { state = baseState(String(levelOrScenario)); },
      snapshot,
      step(inputState = {}, frames = 1) {
        for (let index = 0; index < frames; index += 1) tick(inputState);
        return snapshot();
      },
      runSmokeTest() {
        const checks = [];
        const failures = [];
        const assert = (condition, label) => condition ? checks.push(label) : failures.push(label);
        const paddle = runScenario('paddleMove', { ArrowRight: true }, 12);
        assert(paddle.after.paddleX > paddle.before.paddleX, 'paddleMove changed paddleX');
        const launch = runScenario('launch', { Space: true }, 12);
        assert(launch.after.ball.x !== launch.before.ball.x || launch.after.ball.y !== launch.before.ball.y, 'launch changed ball coordinates');
        const wall = runScenario('wallBounce', {}, 20);
        assert(wall.after.wallBounceCount > wall.before.wallBounceCount, 'wallBounceCount increased');
        const paddleBounce = runScenario('paddleBounce', {}, 20);
        assert(paddleBounce.after.paddleBounceCount > paddleBounce.before.paddleBounceCount, 'paddleBounceCount increased');
        const brick = runScenario('brickHit', {}, 20);
        assert(brick.after.brickCount < brick.before.brickCount && brick.after.score > brick.before.score, 'brick hit reduced brickCount and increased score');
        for (const type of ['wide', 'multi', 'slow', 'through', 'life']) {
          const powerup = runScenario('powerup:' + type, {}, 20);
          assert(powerup.after.powerupsTriggered.includes(type), type + ' powerup triggered');
        }
        const win = runScenario('win', {}, 6);
        assert(win.after.status === 'won', 'win scenario reached won');
        const lose = runScenario('lose', {}, 6);
        assert(lose.after.status === 'lost' && lose.after.lives === 0, 'lose scenario reached lost');
        return {
          passed: failures.length === 0,
          checks,
          failures,
          coverage: {
            levelsPassed: 12,
            totalLevels: 12,
            allLevelsReachable: true,
            mechanics: ['paddle', 'launch', 'wallBounce', 'paddleBounce', 'brickHit'],
            rewards: ['wide', 'multi', 'slow', 'through', 'life'],
            risks: ['lose'],
            stateChanges: ['paddleX', 'ball.x', 'wallBounceCount', 'paddleBounceCount', 'brickCount', 'score', 'powerupsTriggered', 'status', 'lives']
          }
        };
      }
    };
    document.addEventListener('keydown', (event) => {
      if (event.code === 'Space' || event.key === ' ') {
        browserInput.Space = true;
        event.preventDefault();
        return;
      }
      browserInput[event.key] = true;
    });
    document.addEventListener('keyup', (event) => {
      if (event.code === 'Space' || event.key === ' ') {
        browserInput.Space = false;
        return;
      }
      browserInput[event.key] = false;
    });
    function animationLoop() {
      tick(browserInput);
      requestAnimationFrame(animationLoop);
    }
    window.__GAME_TEST__.start();
    requestAnimationFrame(animationLoop);
  </script>
</body>
</html>`;
}

describe('validateGameArtifact breakout subtype', () => {
  it('registers arkanoid as a breakout alias and validates deterministic runtime scenarios', async () => {
    const filePath = await writeFixture(breakoutFixture(), 'arkanoid.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toContain('breakout subtype contract applies');
    expect(result.checks).toContain('breakout runtime browser Space launch moved ball from start state');
    expect(result.checks).toContain('breakout runtime increased wallBounceCount');
    expect(result.checks).toContain('breakout runtime covered wide/multi/slow/through/life powerups');
  });

  it('passes string scenario metadata through to reset instead of numeric indexes', async () => {
    const stringScenarioFixture = breakoutFixture().replace(
      /const scenarios = \[[\s\S]*?\];/,
      `const scenarios = [
      'paddleMove',
      'launch',
      'wallBounce',
      'paddleBounce',
      'brickHit',
      'powerup:wide',
      'powerup:multi',
      'powerup:slow',
      'powerup:through',
      'powerup:life',
      'win',
      'lose'
    ];`,
    );
    const filePath = await writeFixture(stringScenarioFixture, 'arkanoid-string-scenarios.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(true);
    expect(result.failures.join('\n')).not.toContain('startsWith is not a function');
  });

  it('allows runSmokeTest to use global aliases for exposed contract helpers', async () => {
    const globalHelperFixture = breakoutFixture().replace(
      `window.__GAME_TEST__.reset(name);
      const before = snapshot();
      window.__GAME_TEST__.step(input, frames);
      const after = snapshot();`,
      `reset(name);
      const before = snapshot();
      step(input, frames);
      const after = snapshot();`,
    );
    const filePath = await writeFixture(globalHelperFixture, 'arkanoid-global-helper-smoke.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(true);
    expect(result.failures.join('\n')).not.toContain('step is not defined');
  });

  it('lets breakout subtype probes supersede noisy generic author-smoke failures', async () => {
    const noisySmokeFixture = breakoutFixture().replace(
      `return {
          passed: failures.length === 0,`,
      `failures.push('progressPlan: synthetic generic author-smoke noise');
        return {
          passed: false,`,
    );
    const filePath = await writeFixture(noisySmokeFixture, 'arkanoid-noisy-author-smoke.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(true);
    expect(result.checks.join('\n')).toContain('breakout subtype runtime evidence superseded');
  });

  it('accepts structured runSmokeTest coverage when direct scenario probes are shorter than the authored path', async () => {
    const smokeCoverageFallbackFixture = breakoutFixture()
      .replace(`      if (state.scenario === 'wallBounce') state.wallBounceCount += 1;`, `      if (false && state.scenario === 'wallBounce') state.wallBounceCount += 1;`)
      .replace(`      if (state.scenario === 'win') state.status = 'won';`, `      if (false && state.scenario === 'win') state.status = 'won';`)
      .replace(`      if (state.scenario === 'lose') {
        state.status = 'lost';
        state.lives = 0;
      }`, `      if (false && state.scenario === 'lose') {
        state.status = 'lost';
        state.lives = 0;
      }`)
      .replace(
        `window.__GAME_TEST__.step(input, frames);
      const after = snapshot();`,
        `window.__GAME_TEST__.step(input, frames);
      if (name === 'wallBounce') state.wallBounceCount += 1;
      if (name === 'win') state.status = 'won';
      if (name === 'lose') { state.status = 'lost'; state.lives = 0; }
      const after = snapshot();`,
      );
    const filePath = await writeFixture(smokeCoverageFallbackFixture, 'arkanoid-smoke-coverage-fallback.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toContain('breakout runtime covered wallBounceCount via runSmokeTest coverage');
    expect(result.checks).toContain('breakout runtime reached won state');
    expect(result.checks).toContain('breakout runtime reached lost state');
  });

  it('fails breakout artifacts that do not expose deterministic wall bounce evidence', async () => {
    const filePath = await writeFixture(
      breakoutFixture()
        .replace(/wallBounceCount: 0,/g, '')
        .replace(/if \(state\.scenario === 'wallBounce'\) state\.wallBounceCount \+= 1;\n/g, ''),
      'bad-breakout.html',
    );

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('wallBounceCount');
  });

  it('fails breakout artifacts whose browser Space key does not launch the ball', async () => {
    const brokenSpaceFixture = breakoutFixture()
      .replace(
        `if (event.code === 'Space' || event.key === ' ') {
        browserInput.Space = true;
        event.preventDefault();
        return;
      }
      browserInput[event.key] = true;`,
        `browserInput[event.key] = true;
      if (event.key === ' ') event.preventDefault();`,
      )
      .replace(
        `if (event.code === 'Space' || event.key === ' ') {
        browserInput.Space = false;
        return;
      }
      browserInput[event.key] = false;`,
        `browserInput[event.key] = false;`,
      );
    const filePath = await writeFixture(brokenSpaceFixture, 'arkanoid-broken-space.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('真实 Space 发球证据');
  });

  it('fails breakout artifacts whose Space key only works after the test contract starts the game', async () => {
    const contractOnlyStartFixture = breakoutFixture()
      .replace(
        `if (input.Space || input.launch) {
        state.ball.x += state.ball.vx;
        state.ball.y += state.ball.vy;
      }`,
        `if ((input.Space || input.launch) && state.status === 'playing') {
        state.ball.x += state.ball.vx;
        state.ball.y += state.ball.vy;
      }`,
      )
      .replace(
        `window.__GAME_TEST__.start();
    requestAnimationFrame(animationLoop);`,
        `state = baseState('default');
    state.status = 'ready';
    requestAnimationFrame(animationLoop);`,
      );
    const filePath = await writeFixture(contractOnlyStartFixture, 'arkanoid-contract-start-only.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('__GAME_TEST__.start()');
  });

  it('fails breakout artifacts whose contract step moves launch but the live loop never starts', async () => {
    const noRealLoopFixture = breakoutFixture().replace(
      `    requestAnimationFrame(animationLoop);`,
      `    // animation loop intentionally not started`,
    );
    const filePath = await writeFixture(noRealLoopFixture, 'arkanoid-no-real-loop.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('初始加载的开始状态派发浏览器 Space');
  });
});
