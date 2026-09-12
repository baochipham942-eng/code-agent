import { describe, it, expect } from 'vitest';
import path from 'path';

import {
  BreakoutChecker,
  isBreakoutArtifact,
  looksLikeBreakoutGame,
  breakoutChecker,
} from '../../../../../../src/host/agent/runtime/game/breakout/BreakoutChecker';
import { gameSubtypeRegistry } from '../../../../../../src/host/agent/runtime/game/registry';
import {
  BREAKOUT_REPAIR_CODES,
  classifyBreakoutFailure,
  lookupBreakoutRepair,
} from '../../../../../../src/host/agent/runtime/game/breakout/repairCodes';

const PLAYABLE_LOOP = `
  <canvas id="game"></canvas>
  <script>
    const paddle = { x: 100 };
    const ball = { x: 50, y: 50 };
    const bricks = [{ x: 10, y: 10 }];
    document.addEventListener('keydown', () => {});
    function update() {}
    function draw() {}
    function gameLoop() { update(); draw(); requestAnimationFrame(gameLoop); }
    gameLoop();
  </script>
`;

describe('BreakoutChecker identity', () => {
  it('registers breakout and arkanoid', () => {
    expect(gameSubtypeRegistry.get('breakout')).toBe(breakoutChecker);
    expect(gameSubtypeRegistry.get('arkanoid')).toBeInstanceOf(BreakoutChecker);
  });

  it('recognizes META subtype even without a breakout filename', () => {
    expect(isBreakoutArtifact("window.__GAME_META__ = { subtype: 'breakout' }", 'game.html')).toBe(true);
  });

  it('recognizes brick-breaker filename only once META exists', () => {
    expect(isBreakoutArtifact('<canvas></canvas>', 'brick-breaker.html')).toBe(false);
    expect(isBreakoutArtifact("window.__GAME_META__ = { subtype: 'arcade' }", 'brick-breaker.html')).toBe(true);
  });

  it('looksLikeBreakoutGame matches brick-breaker filename without META', () => {
    expect(looksLikeBreakoutGame('<canvas></canvas>', 'brick-breaker.html')).toBe(true);
    expect(looksLikeBreakoutGame('<canvas></canvas>', path.join('runs', 'pixel-breakout.html'))).toBe(true);
  });

  it('looksLikeBreakoutGame matches paddle+ball+bricks+rAF content', () => {
    expect(looksLikeBreakoutGame(PLAYABLE_LOOP, 'game.html')).toBe(true);
  });

  it('does not treat a snake loop as breakout', () => {
    const snake = `
      <canvas id="game"></canvas>
      <script>
        let snake = [[5,5]]; let dir = [1,0];
        document.addEventListener('keydown', () => {});
        function loop() { requestAnimationFrame(loop); }
        loop();
      </script>
    `;
    expect(looksLikeBreakoutGame(snake, 'casual-game-light.html')).toBe(false);
  });
});

describe('missing_breakout_contract repair code', () => {
  it('classifies the presence-failure message', () => {
    const text =
      'breakout 缺少 window.__GAME_META__ 或 window.__GAME_TEST__ 对象赋值；可玩的挡板/弹球循环写完也不算交付完成，必须在 </html> 之前补上这两个直接对象字面量。';
    const entry = classifyBreakoutFailure(text);
    expect(entry?.code).toBe('missing_breakout_contract');
    expect(lookupBreakoutRepair('missing_breakout_contract')?.repairInstruction).toContain('</html>');
    expect(BREAKOUT_REPAIR_CODES).toHaveLength(1);
    expect(breakoutChecker.repairGuidance('missing_breakout_contract')).toContain('__GAME_TEST__');
  });
});
