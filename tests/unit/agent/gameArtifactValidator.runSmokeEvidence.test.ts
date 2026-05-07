import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { validateGameArtifact } from '../../../src/main/agent/runtime/gameArtifactValidator';

async function writeTempHtml(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-game-evidence-'));
  const filePath = path.join(dir, 'game.html');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

describe('validateGameArtifact runSmokeTest evidence', () => {
  it('fails smoke tests that directly mutate progression and win state', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { progress: 0, score: 0, mode: 'playing' };
          const levels = [
            { id: 'intro', score: 0, unlocked: false },
            { id: 'boss', score: 0, unlocked: false }
          ];
          let currentLevel = 0;
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Move right', Space: 'Jump' },
            levels: [{ id: 'intro' }, { id: 'boss' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump'],
              rewards: ['score'],
              risks: ['enemy'],
              levelsCovered: ['intro', 'boss'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() {
              state.progress = 0;
              state.score = 0;
              state.mode = 'playing';
              currentLevel = 0;
            },
            reset(levelId = 'intro') {
              currentLevel = levelId === 'boss' ? 1 : 0;
              state.progress = 0;
            },
            snapshot() {
              return { ...state, level: currentLevel };
            },
            step(input, frames = 1) {
              if (input && input.ArrowRight) {
                state.progress += frames;
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              levels.forEach((level) => {
                level.score = 10;
                level.unlocked = true;
              });
              currentLevel = 1;
              state.score = 20;
              state.mode = 'won';
              return {
                passed: true,
                checks: ['campaign complete'],
                failures: [],
                coverage: {
                  levelsPassed: 2,
                  totalLevels: 2,
                  allLevelsReachable: true,
                  mechanics: ['move', 'jump'],
                  rewards: ['score'],
                  risks: ['enemy'],
                  stateChanges: ['progress', 'score', 'mode', 'level']
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

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('runSmokeTest 直接修改进度'))).toBe(true);
  });

  it('allows smoke tests that prove progression through the shared step path', async () => {
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
            levels: [{ id: 'intro' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['timer'],
              levelsCovered: ['intro'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() {
              state.progress = 0;
              state.score = 0;
              state.mode = 'playing';
            },
            snapshot() {
              return { ...state };
            },
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
                checks: ['progression changed through shared step'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: ['timer'],
                  stateChanges: ['progress', 'score']
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

    const result = await validateGameArtifact(filePath);
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
