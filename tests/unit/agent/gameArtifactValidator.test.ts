import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { validateGameArtifact } from '../../../src/main/agent/runtime/gameArtifactValidator';

async function writeTempHtml(content: string, fileName = 'game.html'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-game-validator-'));
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

describe('validateGameArtifact', () => {
  it('skips non-html files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-game-validator-'));
    const filePath = path.join(dir, 'notes.md');
    await writeFile(filePath, '# notes', 'utf-8');

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.isComplete).toBe(true);
  });

  it('does not validate plain interactive html that is not a game', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <button id="save">Save</button>
        <script>document.getElementById('save').addEventListener('click', () => {});</script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(false);
    expect(result.inferredKind).toBe('interactive_app');
    expect(result.isComplete).toBe(true);
  });

  it('fails game html that lacks playability contract', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }]
          };
          const player = { x: 0, y: 0 };
          let score = 0;
          window.addEventListener('keydown', () => {});
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.inferredKind).toBe('game');
    expect(result.isComplete).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('交互测试合约'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('runSmokeTest'))).toBe(true);
  });

  it('treats canvas + loop + gameplay signals as a game even without explicit game metadata', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="gameCanvas" width="800" height="500"></canvas>
        <script>
          const state = { playerX: 0, score: 0, lives: 3, level: 1 };
          document.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight') {
              state.playerX += 5;
              state.score += 1;
            }
          });
          function update() {
            state.level = Math.max(state.level, 1);
          }
          function gameLoop() {
            update();
            requestAnimationFrame(gameLoop);
          }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.inferredKind).toBe('interactive_app');
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('controls 元数据'))).toBe(true);
  });

  it('treats a canvas gameplay skeleton without metadata as validation-required', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="gc" width="800" height="500"></canvas>
        <script>
          const keys = {};
          const G = { score: 0, lives: 3, currentLevel: 0, corgi: null, platforms: [], enemies: [], mushrooms: [] };
          document.addEventListener('keydown', (event) => { keys[event.code] = true; });
          document.addEventListener('keyup', (event) => { keys[event.code] = false; });
          function aabb(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x; }
          function spawnCorgi() { G.corgi = { x: 0, y: 0, vx: 0, vy: 0 }; }
          spawnCorgi();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.inferredKind).toBe('interactive_app');
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('交互测试合约'))).toBe(true);
  });

  it('fails html that appends non-empty content after closing html', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: { actorReadable: true, mechanics: ['move'] }
          };
          window.__GAME_TEST__ = {
            start: () => {},
            snapshot: () => ({ progress: 0 }),
            runSmokeTest: () => ({ passed: true, checks: [], failures: [], coverage: { levelsPassed: 1, totalLevels: 1 } })
          };
          document.addEventListener('keydown', () => {});
        </script>
      </body>
      </html>const misplaced = true;
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.hasTrailingHtmlContent).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('</html> 之后'))).toBe(true);
  });

  it('passes game html with controls, metadata, and runtime test contract', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script id="game-meta" type="application/json">
          {"domain":"game","subtype":"action","controls":{"right":"ArrowRight"},"levels":[{"id":"1-1"},{"id":"1-2"}],"progressPlan":[{"input":"ArrowRight","metric":"progress","expect":"increase"}],"qualityPlan":{"actorReadable":true,"mechanics":["move"],"rewards":["score"],"risks":["timer"],"levelsCovered":["1-1","1-2"],"allAuthoredLevelsReachable":true}}
        </script>
        <script>
          const state = { x: 0, progress: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'action',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1-1' }, { id: '1-2' }],
            objectives: ['move forward'],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['timer'],
              levelsCovered: ['1-1', '1-2'],
              allAuthoredLevelsReachable: true
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 10;
              state.progress += 1;
              state.score += 5;
            }
          });
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.progress = 0; state.score = 0; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => {
              const before = state.x;
              window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight' }));
              return {
                passed: state.x > before && state.score > 0,
                checks: ['actor moved', 'score changed'],
                failures: [],
                coverage: {
                  levelsPassed: 2,
                  totalLevels: 2,
                  allLevelsReachable: true,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: ['timer'],
                  stateChanges: ['position', 'score']
                }
              };
            }
          };
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.isComplete).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.length).toBeGreaterThanOrEqual(5);
  });

  it('runs runtime smoke when requested and fails if declared controls do not change snapshot', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'score', expect: 'increase' }],
            qualityPlan: { actorReadable: true, mechanics: ['move'] }
          };
          window.addEventListener('keydown', () => {});
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.score = 0; },
            snapshot: () => ({ ...state, progress: state.x }),
            runSmokeTest: () => ({
              passed: true,
              checks: ['self reported ok'],
              failures: [],
              coverage: { mechanics: ['move'], stateChanges: ['none'] }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.runtimeSmoke?.attempted).toBe(true);
    expect(result.failures.some((failure) => failure.includes('snapshot 没有变化'))).toBe(true);
  });

  it('passes runtime smoke when declared controls cause state changes', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score']
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 4;
              state.score += 1;
            }
          });
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.score = 0; },
            snapshot: () => ({ ...state, progress: state.x }),
            runSmokeTest: () => ({
              passed: state.x > 0 && state.score > 0,
              checks: ['declared input moved actor', 'score changed'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: ['score'],
                risks: [],
                stateChanges: ['position', 'score']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks.some((check) => check.includes('snapshot changed after declared controls'))).toBe(true);
  });

  it('accepts object control keys as dispatchable browser inputs', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, progress: 0, status: 'playing' };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right', Space: 'Jump' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump'],
              rewards: ['goal'],
              risks: ['gap']
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 8;
              state.progress += 1;
            }
            if (event.code === 'Space' || event.key === 'Space') {
              state.status = 'jumping';
            }
          });
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.progress = 0; state.status = 'playing'; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => ({
              passed: state.progress > 0,
              checks: ['object control key moved actor'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move', 'jump'],
                rewards: ['goal'],
                risks: ['gap'],
                stateChanges: ['position', 'progress']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks.some((check) => check.includes('snapshot changed after declared controls'))).toBe(true);
  });

  it('supports exact target values and multi-key reachability inputs', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0, status: 'idle', jumpReady: false };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight', jump: 'Space' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: ['ArrowRight', 'Space'], metric: 'status', expect: 'gameWon' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump'],
              rewards: ['goal'],
              risks: ['timer']
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'Space' || event.key === 'Space') state.jumpReady = true;
            if ((event.code === 'ArrowRight' || event.key === 'ArrowRight') && state.jumpReady) {
              state.progress += 1;
              state.status = 'gameWon';
            }
          });
          window.addEventListener('keyup', (event) => {
            if (event.code === 'Space' || event.key === 'Space') state.jumpReady = false;
          });
          window.__GAME_TEST__ = {
            start: () => { state.progress = 0; state.status = 'idle'; state.jumpReady = false; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => ({
              passed: state.status === 'gameWon',
              checks: ['combined input reached win state'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move', 'jump'],
                rewards: ['goal'],
                risks: ['timer'],
                stateChanges: ['status', 'progress']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks).toContain('coverage included mechanics: move, jump');
  });

  it('uses contract step and declared frame counts for deterministic progress plans', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0, status: 'start' };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', frames: 40, metric: 'status', expect: 'checkpoint' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['checkpoint'],
              risks: ['timer']
            }
          };
          window.addEventListener('keydown', () => {});
          function step(input) {
            if (input && input.ArrowRight) {
              state.progress += 1;
              if (state.progress >= 30) state.status = 'checkpoint';
            }
          }
          window.__GAME_TEST__ = {
            start: () => { state.progress = 0; state.status = 'start'; },
            snapshot: () => ({ ...state }),
            step,
            runSmokeTest: () => ({
              passed: state.status === 'checkpoint',
              checks: ['stepped to checkpoint'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: ['checkpoint'],
                risks: ['timer'],
                stateChanges: ['progress', 'status']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks.some((check) => check.includes('reachability step 1'))).toBe(true);
  });

  it('accepts step-driven games without DOM keyboard listeners when snapshot metrics advance', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0, status: 'boot' };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Advance' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', frames: 6, metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['checkpoint']
            }
          };
          window.__GAME_TEST__ = {
            start: () => { state.progress = 0; state.status = 'boot'; },
            snapshot: () => ({ ...state }),
            step: (inputState, frames = 1) => {
              if (inputState && inputState.ArrowRight) {
                state.progress += frames;
                if (state.progress > 0) state.status = 'moving';
              }
            },
            runSmokeTest: () => ({
              passed: state.progress > 0 && state.status === 'moving',
              checks: ['step advanced progress'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: ['checkpoint'],
                risks: [],
                stateChanges: ['progress', 'status']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks.some((check) => check.includes('interactive step probe detected'))).toBe(true);
    expect(result.checks.some((check) => check.includes('snapshot changed after declared controls'))).toBe(true);
  });

  it('passes multi-authored games by resetting each authored unit through reset/step', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const levels = {
            intro: { progress: 0, cleared: false },
            boss: { progress: 0, cleared: false }
          };
          let current = 'intro';
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Advance' },
            levels: [{ id: 'intro' }, { id: 'boss' }],
            progressPlan: [{ input: 'ArrowRight', frames: 3, metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['goal'],
              risks: ['enemy'],
              levelsCovered: ['intro', 'boss'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start: () => { current = 'intro'; levels.intro = { progress: 0, cleared: false }; levels.boss = { progress: 0, cleared: false }; },
            reset: (levelId = 'intro') => {
              current = String(levelId);
              levels[current] = { progress: 0, cleared: false };
            },
            snapshot: () => ({ levelId: current, ...levels[current] }),
            step: (inputState, frames = 1) => {
              if (inputState && inputState.ArrowRight) {
                levels[current].progress += frames;
                if (levels[current].progress >= 3) levels[current].cleared = true;
              }
            },
            runSmokeTest: () => ({
              passed: Object.values(levels).every((level) => level.progress >= 0),
              checks: ['multi-level state machine ok'],
              failures: [],
              coverage: {
                mechanics: ['move'],
                rewards: ['goal'],
                risks: ['enemy'],
                stateChanges: ['progress', 'cleared']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks.some((check) => check.includes('interactive reset probe detected'))).toBe(true);
    expect(result.checks.some((check) => check.includes('reset/step path exercised authored units: intro, boss'))).toBe(true);
  });

  it('accepts long-path reachability when runSmokeTest proves authored-level progression and covers the metrics', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const levels = [
            { id: 0, score: 0, unlocked: false },
            { id: 1, score: 0, unlocked: false },
            { id: 2, score: 0, unlocked: false }
          ];
          let currentLevel = 0;
          let mode = 'menu';
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right', Space: 'Jump' },
            levels: [{ id: 0 }, { id: 1 }, { id: 2 }],
            progressPlan: [
              { input: ['ArrowRight'], frames: 2, metric: 'mode', expect: 'playing' },
              { input: ['ArrowRight'], frames: 2, metric: 'score', expect: 'increase' },
              { input: ['ArrowRight', 'Space'], frames: 2, metric: 'abilities.doubleJump', expect: 'truthy' },
              { input: ['ArrowRight', 'Space'], frames: 2, metric: 'level', expect: 1 },
              { input: ['ArrowRight', 'Space'], frames: 2, metric: 'level', expect: 2 },
              { input: ['ArrowRight', 'Space'], frames: 2, metric: 'mode', expect: 'won' }
            ],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump'],
              rewards: ['score', 'ability'],
              risks: ['enemy'],
              levelsCovered: [0, 1, 2],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start: () => {
              currentLevel = 0;
              mode = 'playing';
              levels.forEach((level) => { level.score = 0; level.unlocked = false; });
            },
            reset: (levelId = 0) => {
              currentLevel = Number(levelId);
              mode = 'playing';
            },
            snapshot: () => ({
              mode,
              level: currentLevel,
              score: levels[currentLevel].score,
              abilities: { doubleJump: levels[currentLevel].unlocked }
            }),
            step: (inputState, frames = 1) => {
              if (inputState && inputState.ArrowRight) {
                levels[currentLevel].score += frames;
              }
              if (inputState && inputState.Space) {
                levels[currentLevel].unlocked = true;
              }
            },
            runSmokeTest: () => {
              currentLevel = 0;
              mode = 'playing';
              levels.forEach((level) => { level.score = 10; level.unlocked = true; });
              currentLevel = 2;
              mode = 'won';
              return {
                passed: true,
                checks: ['full campaign progression verified'],
                failures: [],
                coverage: {
                  levelsPassed: 3,
                  totalLevels: 3,
                  allLevelsReachable: true,
                  mechanics: ['move', 'jump'],
                  rewards: ['score', 'ability'],
                  risks: ['enemy'],
                  stateChanges: ['mode', 'score', 'abilities.doubleJump', 'level']
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks.some((check) => check.includes('runSmokeTest coverage covered reachability metric level'))).toBe(true);
  });

  it('fails multi-authored games without reset when coverage cannot prove all units', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Advance' },
            levels: [{ id: 'intro' }, { id: 'boss' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['goal'],
              risks: ['enemy'],
              levelsCovered: ['intro', 'boss'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start: () => { state.progress = 0; },
            snapshot: () => ({ ...state }),
            step: (inputState, frames = 1) => {
              if (inputState && inputState.ArrowRight) state.progress += frames;
            },
            runSmokeTest: () => ({
              passed: true,
              checks: ['single path only'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: false,
                mechanics: ['move'],
                rewards: ['goal'],
                risks: ['enemy'],
                stateChanges: ['progress']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('reset(levelId/index)'))).toBe(true);
  });

  it('reports missing snapshot metrics in reachability plan', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'powerUp', expect: 'truthy' }],
            qualityPlan: { actorReadable: true, mechanics: ['move'] }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') state.progress += 1;
          });
          window.__GAME_TEST__ = {
            start: () => { state.progress = 0; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => ({
              passed: true,
              checks: ['actor moved'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: [],
                risks: [],
                stateChanges: ['progress']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('snapshot() 结果'))).toBe(true);
  });

  it('fails runtime smoke when progress plan is declared but its metric never advances', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, progress: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['progress']
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 4;
              state.score += 1;
            }
          });
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.progress = 0; state.score = 0; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => ({
              passed: state.x > 0,
              checks: ['actor moved but progress stalled'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: ['score'],
                risks: ['progress'],
                stateChanges: ['position']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('reachability step 1'))).toBe(true);
  });

  it('fails runtime smoke when coverage does not prove all authored levels are reachable', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, progress: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }, { id: '2' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['hazard'],
              levelsCovered: ['1', '2'],
              allAuthoredLevelsReachable: true
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 4;
              state.progress += 1;
              state.score += 1;
            }
          });
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.progress = 0; state.score = 0; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => ({
              passed: true,
              checks: ['actor moved'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 2,
                allLevelsReachable: false,
                mechanics: ['move'],
                rewards: ['score'],
                risks: ['hazard'],
                stateChanges: ['position', 'score']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('authored levels'))).toBe(true);
  });

  it('fails runtime smoke when declared multi-level coverage exists only in levelsCovered metadata', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, progress: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            objectives: ['finish all authored segments'],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['coin'],
              risks: ['pit'],
              levelsCovered: ['1', '2', '3'],
              allAuthoredLevelsReachable: true
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 4;
              state.progress += 1;
              state.score += 1;
            }
          });
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.progress = 0; state.score = 0; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => ({
              passed: true,
              checks: ['actor moved'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: ['coin'],
                risks: ['pit'],
                stateChanges: ['position', 'score']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('declared=3'))).toBe(true);
  });

  it('fails runtime smoke when coverage is missing promised rewards or risks', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, progress: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['mushroom'],
              risks: ['spikes']
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 4;
              state.progress += 1;
            }
          });
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.progress = 0; state.score = 0; },
            snapshot: () => ({ ...state }),
            runSmokeTest: () => ({
              passed: true,
              checks: ['actor moved'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: [],
                risks: [],
                stateChanges: ['position']
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('奖励'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('风险'))).toBe(true);
  });

  it('fails incomplete chunked game html until the final document is closed', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const player = { power: "mushroom" };
          window.addEventListener('keydown', () => {});
          function gameOver() {}
          function winLevel() {}
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }]
          };
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('完整闭合'))).toBe(true);
  });

  it('fails test contracts that auto-collect rewards or auto-finish progression in step()', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, progress: 0, score: 0, mode: 'playing', abilities: {} };
          const treats = [{ x: 200, y: 180, collected: false, ability: 'doubleJump' }];
          const door = { x: 420, y: 180, w: 32, h: 48 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right', Space: 'Jump' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump'],
              rewards: ['double_jump_ability'],
              risks: ['spikes']
            }
          };
          window.__GAME_TEST__ = {
            start() {
              state.x = 0;
              state.progress = 0;
              state.score = 0;
              state.mode = 'playing';
              state.abilities = {};
              treats[0].collected = false;
            },
            snapshot() {
              return { ...state };
            },
            step(input, frames = 1) {
              for (let i = 0; i < frames; i++) {
                if (input && input.ArrowRight) {
                  state.x += 4;
                  state.progress += 1;
                }
                // Auto-collect treats within generous range (test mode)
                const dx = Math.abs(state.x - treats[0].x);
                const dy = 10;
                if (!treats[0].collected && dx < 400 && dy < 300) {
                  treats[0].collected = true;
                  state.score += 10;
                  state.abilities.doubleJump = true;
                }
                // Auto-reach door when close enough (test mode)
                const doorDx = Math.abs(state.x - door.x);
                const doorDy = 20;
                if (doorDx < 400 && doorDy < 300) {
                  state.mode = 'won';
                }
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              this.step({ ArrowRight: true }, 5);
              return {
                passed: true,
                checks: ['auto pass'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move', 'jump'],
                  rewards: ['double_jump_ability'],
                  risks: ['spikes'],
                  stateChanges: ['progress', 'score', 'abilities', 'mode']
                }
              };
            }
          };
          window.addEventListener('keydown', () => {});
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('step() 直接用宽松距离'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('step() 直接推进关卡'))).toBe(true);
  });

  it('fails smoke coverage that claims abilities and enemy interactions without runtime evidence', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0, score: 0, mode: 'playing', abilities: {} };
          const levels = [
            { treats: [{ x: 220, y: 160, ability: 'doubleJump' }], enemies: [{ x: 280, y: 160 }] },
            { treats: [{ x: 360, y: 160, ability: 'dash' }], enemies: [{ x: 420, y: 160 }] }
          ];
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right', Space: 'Jump' },
            levels: [{ id: '1' }, { id: '2' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump', 'enemy_stomp'],
              rewards: ['double_jump_ability', 'dash_ability'],
              risks: ['enemy_damage']
            }
          };
          window.__GAME_TEST__ = {
            start() {
              state.progress = 0;
              state.score = 0;
              state.mode = 'playing';
              state.abilities = {};
            },
            reset(levelId = 0) {
              state.progress = Number(levelId);
              state.mode = 'playing';
            },
            snapshot() {
              return { ...state, level: state.progress };
            },
            step(input, frames = 1) {
              if (input && input.ArrowRight) state.progress += frames;
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              this.step({ ArrowRight: true }, 3);
              const dashStar = levels[1].treats.find((t) => t.ability === 'dash');
              if (dashStar) {
                state.abilities.dash = true;
              }
              return {
                passed: true,
                checks: [
                  'Enemy stomp and hazard avoidance mechanics registered',
                  'Dash ability star exists in Level 2',
                ],
                failures: [],
                coverage: {
                  levelsPassed: 2,
                  totalLevels: 2,
                  allLevelsReachable: true,
                  mechanics: ['move', 'jump', 'enemy_stomp'],
                  rewards: ['double_jump_ability', 'dash_ability'],
                  risks: ['enemy_damage'],
                  stateChanges: ['progress', 'abilities']
                }
              };
            }
          };
          window.addEventListener('keydown', () => {});
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('直接授予能力'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('对象存在、机制注册或覆盖声明'))).toBe(true);
  });

  it('reports orphaned duplicate contract tails after the active game test contract closes', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0, score: 0, mode: 'playing' };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['timer']
            }
          };
          window.__GAME_TEST__ = {
            start() { state.progress = 0; state.score = 0; state.mode = 'playing'; },
            snapshot() { return { ...state }; },
            step(input, frames = 1) {
              if (input && input.ArrowRight) {
                state.progress += frames;
                state.score += frames;
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const after = this.step({ ArrowRight: true }, 5);
              return {
                passed: after.progress > before.progress && after.score > before.score,
                checks: ['movement and score changed through real step'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: [],
                  stateChanges: ['progress', 'score']
                }
              };
            }
          };
          start() { return { mode: 'orphaned' }; },
          runSmokeTest() { return { passed: true, checks: ['orphaned tail'], failures: [] }; }
          window.addEventListener('keydown', () => {});
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('游离'))).toBe(true);
  });

  it('inspects only the active balanced test contract instead of orphaned tail snippets', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0, score: 0, mode: 'playing' };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['timer']
            }
          };
          window.__GAME_TEST__ = {
            start() { state.progress = 0; state.score = 0; state.mode = 'playing'; },
            snapshot() { return { ...state }; },
            step(input, frames = 1) {
              if (input && input.ArrowRight) {
                state.progress += frames;
                state.score += frames;
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const after = this.step({ ArrowRight: true }, 5);
              return {
                passed: after.progress > before.progress && after.score > before.score,
                checks: ['movement and score changed through real step'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: [],
                  stateChanges: ['progress', 'score']
                }
              };
            }
          };
          const orphanedNotes = [
            "step(input) { // Auto-collect treats within generous range (test mode) }",
            "runSmokeTest() { checks.push('Enemy mechanics registered'); }"
          ];
          window.addEventListener('keydown', () => {});
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.failures.some((failure) => failure.includes('step() 直接用宽松距离'))).toBe(false);
    expect(result.failures.some((failure) => failure.includes('对象存在、机制注册或覆盖声明'))).toBe(false);
  });
});
