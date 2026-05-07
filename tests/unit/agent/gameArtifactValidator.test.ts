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

function minimalCanvasGameHtml(style = 'canvas { border: 1px solid #fff; }'): string {
  return `
    <!doctype html>
    <html>
    <head>
      <style>
        body { display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
        ${style}
      </style>
    </head>
    <body>
      <canvas id="game" width="800" height="480"></canvas>
      <script>
        const state = { playerX: 0, score: 0, hazard: false, level: 0 };
        window.__GAME_META__ = {
          domain: 'game',
          subtype: 'arcade',
          controls: { ArrowRight: 'Move right' },
          levels: [{ id: 0, name: 'test' }],
          progressPlan: [{ input: 'ArrowRight', frames: 5, metric: 'playerX', expect: 'increase' }],
          qualityPlan: {
            actorReadable: true,
            mechanics: ['move'],
            rewards: ['score'],
            risks: ['hazard'],
            levelsCovered: [0],
            allAuthoredLevelsReachable: true
          }
        };
        window.__GAME_TEST__ = {
          start() {
            this.reset(0);
          },
          reset(levelOrScenario = 0) {
            state.level = Number(levelOrScenario) || 0;
            state.playerX = 0;
            state.score = 0;
            state.hazard = false;
          },
          snapshot() {
            return { ...state };
          },
          step(inputState, frames = 1) {
            if (inputState && inputState.ArrowRight) {
              state.playerX += frames * 4;
              state.score += frames;
              if (state.playerX > 12) state.hazard = true;
            }
            return this.snapshot();
          },
          runSmokeTest() {
            this.start();
            const before = this.snapshot();
            const after = this.step({ ArrowRight: true }, 5);
            const mechanics = {};
            const rewards = {};
            const risks = {};
            const stateChanges = {};
            if (after.playerX > before.playerX) {
              mechanics.move = true;
              stateChanges.position = true;
            }
            if (after.score > before.score) {
              rewards.scoreGain = true;
            }
            if (after.hazard === true && before.hazard === false) {
              risks.hazardFeedback = true;
            }
            return {
              passed: Boolean(mechanics.move && rewards.scoreGain && risks.hazardFeedback),
              checks: ['input changed playerX, score, and hazard feedback'],
              failures: [],
              coverage: {
                levelsPassed: [0],
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics,
                rewards,
                risks,
                stateChanges
              }
            };
          }
        };
      </script>
    </body>
    </html>
  `;
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

  it('rejects progress metadata that is not an executable progressPlan or reachability array', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <head>
        <style>
          #game {
            max-width: 100vw;
            max-height: 100vh;
            width: 100%;
            height: auto;
            aspect-ratio: 800 / 480;
          }
        </style>
      </head>
      <body>
        <canvas id="game" width="800" height="480"></canvas>
        <script>
          const state = { progress: 0, player: { x: 0, y: 0 }, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'platformer',
            controls: { right: 'ArrowRight', jump: 'Space' },
            levels: [{ id: 'roofline', name: 'Roofline' }],
            progress: {
              goal: 'reach the checkpoint',
              coverage: ['move', 'jump']
            },
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump'],
              rewards: ['checkpoint'],
              risks: ['gap'],
              levelsCovered: ['roofline'],
              allAuthoredLevelsReachable: true
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight') {
              state.player.x += 4;
              state.progress += 1;
            }
          });
          window.__GAME_TEST__ = {
            start() { this.reset(); },
            reset() {
              state.progress = 0;
              state.player.x = 0;
              state.player.y = 0;
              state.score = 0;
              return this.snapshot();
            },
            snapshot() {
              return { progress: state.progress, player: { ...state.player }, score: state.score };
            },
            step(inputState = {}, frames = 1) {
              if (inputState.ArrowRight) {
                state.player.x += frames * 4;
                state.progress += frames;
              }
              if (inputState.Space) state.player.y -= 12;
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const after = this.step({ ArrowRight: true }, 4);
              return {
                passed: after.player.x > before.player.x,
                checks: ['player moved right'],
                failures: [],
                coverage: {
                  levelsPassed: ['roofline'],
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: { move: true },
                  rewards: {},
                  risks: {},
                  stateChanges: { playerX: true }
                }
              };
            }
          };
        </script>
      </body>
      </html>
    `, 'near-miss-progress.html');

    const result = await validateGameArtifact(filePath);

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('progress/coverage'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('progressPlan'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('不算可执行验收计划'))).toBe(true);
  });

  it('fails large fixed canvas without responsive viewport sizing', async () => {
    const filePath = await writeTempHtml(minimalCanvasGameHtml(), 'fixed-canvas.html');

    const result = await validateGameArtifact(filePath);

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('大型固定 canvas'))).toBe(true);
  });

  it('accepts fixed internal canvas resolution when CSS scales the playfield', async () => {
    const filePath = await writeTempHtml(minimalCanvasGameHtml(`
      #game {
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 24px);
        width: min(800px, 100%);
        height: auto;
        aspect-ratio: 800 / 480;
      }
    `), 'responsive-canvas.html');

    const result = await validateGameArtifact(filePath);

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.checks).toContain('responsive canvas sizing detected');
  });

  it('fails platformers that only move and jump without gameplay mechanics', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <head>
        <style>
          #game { max-width: 100vw; max-height: 100vh; width: 100%; height: auto; aspect-ratio: 800 / 480; }
        </style>
      </head>
      <body>
        <canvas id="game" width="800" height="480"></canvas>
        <script>
          const state = { player: { x: 0, y: 0, vy: 0 }, progress: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'platformer',
            controls: { right: 'ArrowRight', jump: 'Space' },
            levels: [{ id: 'plain-route' }],
            progressPlan: [{ input: 'ArrowRight', frames: 8, metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump'],
              rewards: ['goal'],
              risks: ['gap'],
              levelsCovered: ['plain-route'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() { this.reset(); },
            reset() { state.player.x = 0; state.player.y = 0; state.player.vy = 0; state.progress = 0; },
            snapshot() { return { player: { ...state.player }, progress: state.progress }; },
            step(input = {}, frames = 1) {
              if (input.right || input.ArrowRight) {
                state.player.x += frames * 4;
                state.progress += frames;
              }
              if (input.jump || input.Space) state.player.vy = -10;
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const after = this.step({ ArrowRight: true, Space: true }, 4);
              return {
                passed: after.progress > before.progress && after.player.vy !== before.player.vy,
                checks: ['move and jump work'],
                failures: [],
                coverage: {
                  levelsPassed: ['plain-route'],
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move', 'jump'],
                  rewards: ['goal'],
                  risks: ['gap'],
                  stateChanges: ['progress', 'player.vy']
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'plain-platformer.html');

    const result = await validateGameArtifact(filePath);

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('缺少 gameplayMechanics'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('enemies'))).toBe(true);
  });

  it('fails platformers that declare mechanics without runtime coverage evidence', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <head>
        <style>
          #game { max-width: 100vw; max-height: 100vh; width: 100%; height: auto; aspect-ratio: 800 / 480; }
        </style>
      </head>
      <body>
        <canvas id="game" width="800" height="480"></canvas>
        <script>
          const state = {
            player: { x: 0, y: 0, vy: 0, abilities: {} },
            progress: 0,
            enemiesDefeated: 0,
            blocksUsed: 0,
            spawnedReward: 0,
            abilities: {},
            gates: { upperRoute: false },
            routeReachable: false
          };
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'platformer',
            controls: { right: 'ArrowRight', jump: 'Space', stomp: 'KeyS', bump: 'ArrowUp', collect: 'KeyE', doubleJump: 'ShiftLeft' },
            levels: [{ id: 'declared-route' }],
            gameplayMechanics: {
              enemies: [{ id: 'goomba-1', type: 'patrol', stompable: true, patrol: { from: 280, to: 420 }, defeatReward: 'bounceCoin' }],
              blocks: [{ id: 'q1', type: 'question', bumpableFromBelow: true, reward: 'doubleJump', usedState: 'empty' }],
              abilities: [{ id: 'doubleJump', type: 'doubleJump', acquiredFrom: 'q1', effect: 'second air jump', unlocksRoute: 'upper-route' }],
              gates: [{ id: 'upper-gap', requiresAbility: 'doubleJump', blocksAccessTo: 'upper-route' }],
              comboChallenge: [{ id: 'combo-1', requires: ['jump', 'stomp', 'bumpBlock', 'doubleJump'], target: 'upper-route' }]
            },
            progressPlan: [{ input: 'ArrowRight', frames: 5, metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump', 'stompEnemy', 'bumpBlock', 'gainAbility', 'unlockGate', 'comboChallenge'],
              rewards: ['defeatReward', 'blockAbility'],
              risks: ['stompableEnemy'],
              levelsCovered: ['declared-route'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() { this.reset(); },
            reset() {
              state.player.x = 0;
              state.player.y = 0;
              state.player.vy = 0;
              state.player.abilities = {};
              state.progress = 0;
              state.enemiesDefeated = 0;
              state.blocksUsed = 0;
              state.spawnedReward = 0;
              state.abilities = {};
              state.gates.upperRoute = false;
              state.routeReachable = false;
            },
            snapshot() { return JSON.parse(JSON.stringify(state)); },
            step(input = {}, frames = 1) {
              if (input.right || input.ArrowRight) {
                state.player.x += frames * 4;
                state.progress += frames;
              }
              if (input.jump || input.Space) state.player.vy = -8;
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const after = this.step({ ArrowRight: true }, 5);
              return {
                passed: after.progress > before.progress,
                checks: ['movement only'],
                failures: [],
                coverage: {
                  levelsPassed: ['declared-route'],
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move', 'jump'],
                  rewards: [],
                  risks: [],
                  stateChanges: ['progress']
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'declared-platformer.html');

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });

    console.log({ failures: result.failures, runtimeFailures: result.runtimeSmoke?.failures, runtimeChecks: result.runtimeSmoke?.checks });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('runtime 证据'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('stompable enemy'))).toBe(true);
  });

  it('passes a minimal platformer gameplay mechanics contract with stomp, block, ability, gate, and combo evidence', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <head>
        <style>
          #game { max-width: 100vw; max-height: 100vh; width: 100%; height: auto; aspect-ratio: 800 / 480; }
        </style>
      </head>
      <body>
        <canvas id="game" width="800" height="480"></canvas>
        <script>
          const initial = () => ({
            player: { x: 0, y: 0, vy: 0, bounce: false, abilities: { doubleJump: false } },
            progress: 0,
            enemiesDefeated: 0,
            blocksUsed: 0,
            spawnedReward: 0,
            abilities: { doubleJump: false },
            gates: { upperRoute: false },
            routeReachable: false,
            comboChallengeComplete: false
          });
          let state = initial();
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'platformer',
            controls: { right: 'ArrowRight', jump: 'Space', stomp: 'KeyS', bump: 'ArrowUp', collect: 'KeyE', doubleJump: 'ShiftLeft' },
            levels: [{ id: 'mechanics-route' }],
            gameplayMechanics: {
              enemies: [{ id: 'goomba-1', type: 'patrol', stompable: true, patrol: { from: 280, to: 420 }, defeatReward: 'bounceCoin' }],
              blocks: [{ id: 'q1', type: 'question', bumpableFromBelow: true, reward: 'doubleJump', usedState: 'empty' }],
              abilities: [{ id: 'doubleJump', type: 'doubleJump', acquiredFrom: 'q1', effect: 'second air jump', unlocksRoute: 'upper-route' }],
              gates: [{ id: 'upper-gap', requiresAbility: 'doubleJump', blocksAccessTo: 'upper-route' }],
              comboChallenge: [{ id: 'combo-1', requires: ['jump', 'stomp', 'bumpBlock', 'doubleJump'], target: 'upper-route' }]
            },
            progressPlan: [
              { input: 'ArrowRight', frames: 5, metric: 'progress', expect: 'increase' },
              { input: 'Space', frames: 1, metric: 'player.vy', expect: 'change' }
            ],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move', 'jump', 'stompEnemy', 'bumpBlock', 'gainAbility', 'unlockGate', 'comboChallenge'],
              rewards: ['defeatReward', 'blockAbility'],
              risks: ['stompableEnemy'],
              levelsCovered: ['mechanics-route'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() { state = initial(); return this.snapshot(); },
            reset() { state = initial(); return this.snapshot(); },
            snapshot() { return JSON.parse(JSON.stringify(state)); },
            step(input = {}, frames = 1) {
              const pressed = (name, code) => Boolean(input[name] || input[code]);
              if (pressed('right', 'ArrowRight')) {
                state.player.x += frames * 4;
                state.progress += frames;
              }
              if (pressed('jump', 'Space')) {
                state.player.vy = state.abilities.doubleJump ? -16 : -8;
              }
              if (pressed('jump', 'Space') && pressed('stomp', 'KeyS') && state.enemiesDefeated === 0) {
                state.enemiesDefeated += 1;
                state.player.vy = -12;
                state.player.bounce = true;
              }
              if (pressed('jump', 'Space') && pressed('bump', 'ArrowUp') && state.blocksUsed === 0) {
                state.blocksUsed += 1;
                state.spawnedReward += 1;
              }
              if (pressed('collect', 'KeyE') && state.spawnedReward > 0) {
                state.abilities.doubleJump = true;
                state.player.abilities.doubleJump = true;
              }
              if (pressed('doubleJump', 'ShiftLeft') && state.abilities.doubleJump) {
                state.gates.upperRoute = true;
                state.routeReachable = true;
              }
              if (
                pressed('jump', 'Space')
                && pressed('stomp', 'KeyS')
                && pressed('bump', 'ArrowUp')
                && pressed('doubleJump', 'ShiftLeft')
                && state.routeReachable
              ) {
                state.comboChallengeComplete = true;
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const afterStomp = this.step({ jump: true, stomp: true }, 1);
              const afterBlock = this.step({ jump: true, bump: true }, 1);
              const beforeAbility = this.snapshot();
              const afterAbility = this.step({ collect: true }, 1);
              const beforeGate = this.snapshot();
              const afterGate = this.step({ doubleJump: true }, 1);
              const afterCombo = this.step({ jump: true, stomp: true, bump: true, doubleJump: true }, 1);
              const passed = afterStomp.enemiesDefeated > before.enemiesDefeated
                && afterStomp.player.vy !== before.player.vy
                && afterBlock.blocksUsed > before.blocksUsed
                && afterBlock.spawnedReward > before.spawnedReward
                && beforeAbility.abilities.doubleJump === false
                && afterAbility.abilities.doubleJump === true
                && beforeGate.routeReachable === false
                && afterGate.routeReachable === true
                && afterCombo.comboChallengeComplete === true;
              return {
                passed,
                checks: [
                  'stompEnemy defeated enemy and changed player.vy bounce',
                  'bumpBlock used question block and spawnedReward',
                  'gainAbility changed abilities.doubleJump',
                  'unlockGate made routeReachableAfterAbility true',
                  'comboChallenge sequence covered jump stomp bumpBlock doubleJump'
                ],
                failures: passed ? [] : ['platformer mechanics sequence failed'],
                coverage: {
                  levelsPassed: ['mechanics-route'],
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move', 'jump', 'stompEnemy', 'bumpBlock', 'gainAbility', 'unlockGate', 'comboChallenge'],
                  rewards: ['defeatReward', 'blockAbility'],
                  risks: ['stompableEnemy'],
                  stateChanges: [
                    'progress',
                    'enemiesDefeated',
                    'player.vy',
                    'blocksUsed',
                    'spawnedReward',
                    'abilities.doubleJump',
                    'gates.upperRoute',
                    'routeReachableAfterAbility',
                    'comboChallenge'
                  ]
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'good-platformer.html');

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks).toContain('platformer gameplay runtime covered stompable enemy with defeated/bounce evidence');
    expect(result.checks).toContain('platformer gameplay runtime covered ability-gated route evidence');
    expect(result.checks).toContain('platformer gameplay runtime covered comboChallenge evidence');
  });

  it('does not count failed platformer smoke labels as positive mechanics evidence', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <head>
        <style>
          #game { max-width: 100vw; max-height: 100vh; width: 100%; height: auto; aspect-ratio: 800 / 480; }
        </style>
      </head>
      <body>
        <canvas id="game" width="800" height="480"></canvas>
        <script>
          const state = {
            player: { x: 0, y: 0, vy: 0, abilities: { doubleJump: false } },
            enemiesDefeated: 0,
            blocksUsed: 0,
            spawnedReward: 0,
            abilities: { doubleJump: false },
            gatesUnlocked: 0,
            routesUnlocked: 0
          };
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'platformer',
            controls: { right: 'ArrowRight', jump: 'Space' },
            levels: [{ id: 'false-labels' }],
            gameplayMechanics: {
              enemies: [{ id: 'goomba-1', type: 'patrol', stompable: true, patrol: true, defeatReward: 'coin' }],
              blocks: [{ id: 'q1', type: 'question', bumpableFromBelow: true, reward: 'doubleJump', usedState: 'empty' }],
              abilities: [{ id: 'doubleJump', type: 'doubleJump', acquiredFrom: 'q1', effect: 'second jump', unlocksRoute: 'upper-route' }],
              gates: [{ id: 'upper-gap', requiresAbility: 'doubleJump', blocksAccessTo: 'upper-route' }],
              comboChallenge: [{ id: 'combo-1', requires: ['jump', 'stomp', 'doubleJump'], target: 'upper-route' }]
            },
            progressPlan: [{ input: 'ArrowRight', frames: 5, metric: 'player.x', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['stompEnemy', 'bumpBlock', 'gainAbility', 'unlockGate', 'comboChallenge'],
              rewards: ['defeatReward', 'blockAbility'],
              risks: ['enemy'],
              levelsCovered: ['false-labels'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() { return this.snapshot(); },
            reset() { return this.snapshot(); },
            snapshot() { return JSON.parse(JSON.stringify(state)); },
            step() { return this.snapshot(); },
            runSmokeTest() {
              return {
                passed: false,
                checks: [
                  'Stomp Enemy: false',
                  'Bump Block: false',
                  'Gain Ability: false',
                  'Unlock Gate: false',
                  'comboChallenge false'
                ],
                failures: ['platformer mechanics failed'],
                coverage: {
                  levelsPassed: [],
                  totalLevels: 1,
                  allLevelsReachable: false,
                  mechanics: ['stompEnemy false', 'bumpBlock false', 'comboChallenge false'],
                  rewards: [],
                  risks: [],
                  stateChanges: []
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'bad-platformer-false-labels.html');

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.checks).not.toContain('platformer gameplay runtime covered stompable enemy with defeated/bounce evidence');
    expect(result.checks).not.toContain('platformer gameplay runtime covered bumpable block evidence');
    expect(result.checks).not.toContain('platformer gameplay runtime covered comboChallenge evidence');
    expect(result.failures.some((failure) => failure.includes('stompable enemy'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('comboChallenge coverage'))).toBe(true);
  });

  it('does not count scenario-granted abilities or false boolean coverage as runtime mechanics evidence', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <head>
        <style>
          #game { max-width: 100vw; max-height: 100vh; width: 100%; height: auto; aspect-ratio: 800 / 480; }
        </style>
      </head>
      <body>
        <canvas id="game" width="800" height="480"></canvas>
        <script>
          const makeState = () => ({
            player: { x: 0, y: 0, vy: 0, abilities: { doubleJump: false } },
            enemies: [{ id: 'goomba-1', defeated: false }],
            blocks: [{ id: 'q1', type: 'question', used: false }],
            abilities: { doubleJump: false },
            gates: { upperRoute: false },
            progress: 0
          });
          let state = makeState();
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'platformer',
            controls: { right: 'ArrowRight', jump: 'Space' },
            levels: [{ id: 'scenario-grant' }],
            gameplayMechanics: {
              enemies: [{ id: 'goomba-1', type: 'patrol', stompable: true, patrol: true, defeatReward: 'coin' }],
              blocks: [{ id: 'q1', type: 'question', bumpableFromBelow: true, reward: 'doubleJump', usedState: 'empty' }],
              abilities: [{ id: 'doubleJump', type: 'doubleJump', acquiredFrom: 'q1', effect: 'second jump', unlocksRoute: 'upper-route' }],
              gates: [{ id: 'upper-gap', requiresAbility: 'doubleJump', blocksAccessTo: 'upper-route' }],
              comboChallenge: [{ id: 'combo-1', requires: ['jump', 'stomp', 'bumpBlock', 'doubleJump'], target: 'upper-route' }]
            },
            progressPlan: [{ input: 'ArrowRight', frames: 4, metric: 'player.x', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['stompEnemy', 'bumpBlock', 'gainAbility', 'unlockGate', 'comboChallenge'],
              rewards: ['defeatReward', 'blockAbility'],
              risks: ['enemy'],
              levelsCovered: ['scenario-grant'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() { state = makeState(); return this.snapshot(); },
            reset(scenario) {
              state = makeState();
              if (scenario === 'unlockGate') {
                state.player.abilities.doubleJump = true;
                state.abilities.doubleJump = true;
                state.gates.upperRoute = true;
              }
              return this.snapshot();
            },
            snapshot() { return JSON.parse(JSON.stringify(state)); },
            step(input = {}, frames = 1) {
              if (input.ArrowRight || input.right) {
                state.player.x += frames * 4;
                state.progress += frames;
              }
              if (input.Space || input.jump) state.player.vy = -8;
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              this.reset('unlockGate');
              return {
                passed: false,
                checks: ['Stomp Enemy: false', 'Bump Block: false', 'Gain Ability: false', 'Unlock Gate: true'],
                failures: ['stomp/bump/gain ability failed'],
                coverage: {
                  levelsPassed: ['scenario-grant'],
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: { stompEnemy: false, bumpBlock: false, gainAbility: false, unlockGate: true },
                  rewards: { defeatReward: false, blockAbility: false },
                  risks: {},
                  stateChanges: { gateUnlocked: true }
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'scenario-granted-ability.html');

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.checks).not.toContain('platformer gameplay runtime covered ability acquisition evidence');
    expect(result.checks).not.toContain('platformer gameplay runtime covered ability-gated route evidence');
    expect(result.checks).not.toContain('platformer gameplay runtime covered stompable enemy with defeated/bounce evidence');
    expect(result.failures.some((failure) => failure.includes('ability 必须通过真实输入获得'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('gate 必须在获得技能后改变'))).toBe(true);
  });

  it('skips browser visual smoke without failing when system Chrome is unavailable', async () => {
    const oldChromePath = process.env.CHROME_PATH;
    const oldSystemChromePath = process.env.CODE_AGENT_SYSTEM_CHROME_PATH;
    const oldBrowserProvider = process.env.CODE_AGENT_BROWSER_PROVIDER;
    process.env.CHROME_PATH = '';
    process.env.CODE_AGENT_SYSTEM_CHROME_PATH = '/not/a/real/chrome';
    process.env.CODE_AGENT_BROWSER_PROVIDER = 'system-chrome-cdp';

    try {
      const filePath = await writeTempHtml(minimalCanvasGameHtml(`
        #game {
          max-width: 100vw;
          max-height: 100vh;
          width: 100%;
          height: auto;
          aspect-ratio: 800 / 480;
        }
      `), 'visual-smoke-skipped.html');

      const result = await validateGameArtifact(filePath, {
        runBrowserVisualSmoke: true,
      });

      expect(result.passed).toBe(true);
      expect(result.browserVisualSmoke).toMatchObject({
        attempted: false,
        skipped: true,
        passed: true,
      });
      expect(result.checks.some((check) => check.includes('browser visual smoke skipped'))).toBe(true);
    } finally {
      if (typeof oldChromePath === 'undefined') delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = oldChromePath;
      if (typeof oldSystemChromePath === 'undefined') delete process.env.CODE_AGENT_SYSTEM_CHROME_PATH;
      else process.env.CODE_AGENT_SYSTEM_CHROME_PATH = oldSystemChromePath;
      if (typeof oldBrowserProvider === 'undefined') delete process.env.CODE_AGENT_BROWSER_PROVIDER;
      else process.env.CODE_AGENT_BROWSER_PROVIDER = oldBrowserProvider;
    }
  });

  it('still reports frontend browser validation evidence when static artifact validation fails', async () => {
    const oldChromePath = process.env.CHROME_PATH;
    const oldSystemChromePath = process.env.CODE_AGENT_SYSTEM_CHROME_PATH;
    const oldBrowserProvider = process.env.CODE_AGENT_BROWSER_PROVIDER;
    process.env.CHROME_PATH = '';
    process.env.CODE_AGENT_SYSTEM_CHROME_PATH = '/not/a/real/chrome';
    process.env.CODE_AGENT_BROWSER_PROVIDER = 'system-chrome-cdp';

    try {
      const filePath = await writeTempHtml(`
        <!doctype html>
        <html>
        <body>
          <canvas id="game" width="800" height="480" style="width: 100%; max-width: 800px; height: auto; aspect-ratio: 800 / 480;"></canvas>
          <script>
            window.__GAME_META__ = {
              domain: 'game',
              subtype: 'platformer',
              controls: { ArrowRight: 'Move right' },
              gameplayMechanics: {
                enemies: [{ id: 'enemy-1', stompable: true }],
                blocks: [{ id: 'q1', type: 'question', bumpableFromBelow: true, reward: 'doubleJump', usedState: 'empty' }],
                abilities: [{ id: 'doubleJump', type: 'doubleJump', acquiredFrom: 'q1', effect: 'second air jump', unlocksRoute: 'upper-route' }],
                gates: [{ id: 'gate-1', requiresAbility: 'doubleJump', blocksAccessTo: 'upper-route' }],
                comboChallenge: [{ id: 'combo-1', requires: ['jump', 'stomp', 'doubleJump'], target: 'upper-route' }]
              }
            };
            window.__GAME_TEST__ = {
              start() { return {}; },
              snapshot() { return { playerX: 0 }; },
              runSmokeTest() { return { passed: false, checks: [], failures: ['not covered'], coverage: {} }; }
            };
          </script>
        </body>
        </html>
      `, 'static-fail-visual-evidence-platformer.html');

      const result = await validateGameArtifact(filePath, {
        runBrowserVisualSmoke: true,
      });

      expect(result.passed).toBe(false);
      expect(result.failures.some((failure) => failure.includes('缺少可用于验收'))).toBe(true);
      expect(result.browserVisualSmoke).toMatchObject({
        attempted: false,
        skipped: true,
        passed: true,
      });
      expect(result.checks.some((check) => check.includes('browser visual smoke skipped'))).toBe(true);
    } finally {
      if (typeof oldChromePath === 'undefined') delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = oldChromePath;
      if (typeof oldSystemChromePath === 'undefined') delete process.env.CODE_AGENT_SYSTEM_CHROME_PATH;
      else process.env.CODE_AGENT_SYSTEM_CHROME_PATH = oldSystemChromePath;
      if (typeof oldBrowserProvider === 'undefined') delete process.env.CODE_AGENT_BROWSER_PROVIDER;
      else process.env.CODE_AGENT_BROWSER_PROVIDER = oldBrowserProvider;
    }
  });

  it('runs runtime smoke evidence even when static artifact metadata fails', async () => {
    const filePath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game" width="320" height="180" style="width: 100%; max-width: 320px; height: auto; aspect-ratio: 16 / 9;"></canvas>
        <script>
          const state = { playerX: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'arcade',
            controls: { ArrowRight: 'Move right' },
            progressPlan: [{ input: 'ArrowRight', frames: 2, metric: 'playerX', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['hazard'],
              levelsCovered: 1,
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() { this.reset(); return this.snapshot(); },
            reset() { state.playerX = 0; return this.snapshot(); },
            snapshot() { return { playerX: state.playerX }; },
            step(input, frames = 1) {
              if (input && input.ArrowRight) state.playerX += frames * 4;
              return this.snapshot();
            },
            runSmokeTest() {
              this.reset();
              return {
                passed: false,
                checks: [],
                failures: ['runtime coverage did not exercise generated scene'],
                coverage: {}
              };
            }
          };
        </script>
      </body>
      </html>
    `, 'static-fail-runtime-evidence.html');

    const result = await validateGameArtifact(filePath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('缺少可用于验收'))).toBe(true);
    expect(result.runtimeSmoke?.attempted).toBe(true);
    expect(result.failures.some((failure) => failure.includes('runtime coverage did not exercise generated scene'))).toBe(true);
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
            progressPlan: [{ input: 'ArrowRight', metric: 'actors[0].x', expect: 'increase' }],
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

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 8000 });
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

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 8000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks.some((check) => check.includes('snapshot changed after declared controls'))).toBe(true);
  });

  it('accepts shorthand exported game test contract functions', async () => {
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
              rewards: ['score'],
              risks: ['wall']
            }
          };
          function start() {
            state.x = 0;
            state.score = 0;
            return snapshot();
          }
          function reset() {
            return start();
          }
          function snapshot() {
            return { ...state, progress: state.x, actors: [{ x: state.x }] };
          }
          function step(input = {}, frames = 1) {
            if (input.right) {
              state.x += frames * 4;
              state.score += frames;
            }
            return snapshot();
          }
          function runSmokeTest() {
            const before = snapshot();
            step({ right: true, ArrowRight: true }, 4);
            const after = snapshot();
            return {
              passed: after.x > before.x && after.score > before.score,
              checks: ['shorthand contract drove movement'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: ['score'],
                risks: ['wall'],
                stateChanges: ['position', 'score']
              }
            };
          }
          window.__GAME_TEST__ = { start, reset, snapshot, step, runSmokeTest };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `);

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 8000 });
    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runtimeSmoke?.passed).toBe(true);
    expect(result.checks).toContain('interactive start probe detected');
    expect(result.checks).toContain('interactive runtime smoke probe detected');
  });

  it('rejects successful runtime smoke results that return numeric checks instead of string arrays', async () => {
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
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.score = 0; },
            snapshot: () => ({ ...state, progress: state.x }),
            step(input = {}, frames = 1) {
              if (input.right || input.ArrowRight) {
                state.x += frames * 4;
                state.score += frames;
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const after = this.step({ right: true }, 3);
              return {
                passed: after.x > before.x && after.score > before.score,
                checks: 2,
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
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'numeric-checks-smoke.html');

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('runSmokeTest.checks 必须是字符串数组'))).toBe(true);
  });

  it('rejects numeric runtime coverage counts instead of named evidence', async () => {
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
          window.__GAME_TEST__ = {
            start: () => { state.x = 0; state.score = 0; },
            snapshot: () => ({ ...state, progress: state.x }),
            step(input = {}, frames = 1) {
              if (input.right || input.ArrowRight) {
                state.x += frames * 4;
                state.score += frames;
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const before = this.snapshot();
              const after = this.step({ right: true }, 3);
              return {
                passed: after.x > before.x && after.score > before.score,
                checks: ['declared input moved actor'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: 1,
                  rewards: 1,
                  risks: 0,
                  stateChanges: 2
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'numeric-coverage-smoke.html');

    const result = await validateGameArtifact(filePath, { runRuntimeSmoke: true, runtimeSmokeTimeoutMs: 5000 });

    expect(result.shouldValidate).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('coverage.mechanics') && failure.includes('不能只返回数字'))).toBe(true);
    expect(result.failures.some((failure) => failure.includes('coverage.stateChanges') && failure.includes('不能只返回数字'))).toBe(true);
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

  it('regresses multi-segment artifacts against metadata, reachability, and authored-unit smoke coverage', async () => {
    const missingContractPath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { playerX: 0, score: 0, progress: 0, stage: 'opening', hazard: false };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight') {
              state.playerX += 8;
              state.progress += 1;
              state.score += 1;
            }
          });
          function update() {
            state.hazard = state.progress > 4;
          }
          function gameLoop() {
            update();
            requestAnimationFrame(gameLoop);
          }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'missing-contract-segments.html');

    const missingContract = await validateGameArtifact(missingContractPath);
    expect(missingContract.shouldValidate).toBe(true);
    expect(missingContract.passed).toBe(false);
    expect(missingContract.failures.some((failure) => failure.includes('关卡、片段、场景或目标元数据'))).toBe(true);
    expect(missingContract.failures.some((failure) => failure.includes('reachability/acceptance/progressPlan'))).toBe(true);
    expect(missingContract.failures.some((failure) => failure.includes('交互测试合约'))).toBe(true);

    const firstSegmentOnlyPath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { segmentId: 'opening', progress: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Advance' },
            segments: [{ id: 'opening' }, { id: 'bridge' }, { id: 'boss' }],
            progressPlan: [{ input: 'ArrowRight', frames: 3, metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['pit'],
              levelsCovered: ['opening', 'bridge', 'boss'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() {
              state.segmentId = 'opening';
              state.progress = 0;
              state.score = 0;
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
              this.step({ ArrowRight: true }, 3);
              return {
                passed: state.progress > 0,
                checks: ['only first segment advanced'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 3,
                  allLevelsReachable: false,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: ['pit'],
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
    `, 'first-segment-only.html');

    const firstSegmentOnly = await validateGameArtifact(firstSegmentOnlyPath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });
    expect(firstSegmentOnly.shouldValidate).toBe(true);
    expect(firstSegmentOnly.passed).toBe(false);
    expect(firstSegmentOnly.failures.some((failure) => failure.includes('declared=3') && failure.includes('passed=1'))).toBe(true);

    const completeSegmentsPath = await writeTempHtml(`
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const segments = {
            opening: { progress: 0, cleared: false, score: 0 },
            bridge: { progress: 0, cleared: false, score: 0 },
            boss: { progress: 0, cleared: false, score: 0 }
          };
          let current = 'opening';
          window.__GAME_META__ = {
            domain: 'game',
            controls: { ArrowRight: 'Advance' },
            segments: [{ id: 'opening' }, { id: 'bridge' }, { id: 'boss' }],
            progressPlan: [{ input: 'ArrowRight', frames: 3, metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['pit'],
              levelsCovered: ['opening', 'bridge', 'boss'],
              allAuthoredLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() {
              current = 'opening';
              Object.values(segments).forEach((segment) => {
                segment.progress = 0;
                segment.cleared = false;
                segment.score = 0;
              });
            },
            reset(segmentId = 'opening') {
              current = String(segmentId);
              segments[current].progress = 0;
              segments[current].cleared = false;
              segments[current].score = 0;
            },
            snapshot() {
              return { segmentId: current, ...segments[current] };
            },
            step(input, frames = 1) {
              if (input && input.ArrowRight) {
                segments[current].progress += frames;
                segments[current].score += frames;
                if (segments[current].progress >= 3) segments[current].cleared = true;
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              const clearedSegments = [];
              for (const segmentId of Object.keys(segments)) {
                this.reset(segmentId);
                const before = this.snapshot();
                const after = this.step({ ArrowRight: true }, 3);
                if (after.progress > before.progress && after.cleared && after.score > before.score) {
                  clearedSegments.push(segmentId);
                }
              }
              return {
                passed: clearedSegments.length === Object.keys(segments).length,
                checks: [
                  'segments cleared: ' + clearedSegments.join(', '),
                  'coverage declared 3/3 authored segments'
                ],
                failures: [],
                coverage: {
                  levelsPassed: clearedSegments,
                  totalLevels: Object.keys(segments).length,
                  allLevelsReachable: true,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: ['pit'],
                  stateChanges: ['progress', 'score', 'segment_completion']
                }
              };
            }
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'complete-segments.html');

    const completeSegments = await validateGameArtifact(completeSegmentsPath, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 5000,
    });
    expect(completeSegments.shouldValidate).toBe(true);
    expect(completeSegments.passed).toBe(true);
    expect(completeSegments.runtimeSmoke?.passed).toBe(true);
    expect(completeSegments.checks).toContain('segments cleared: opening, bridge, boss');
    expect(completeSegments.checks).toContain('coverage declared 3/3 authored segments');
    expect(completeSegments.checks.some((check) => check.includes('reset/step path exercised authored units: opening, bridge, boss'))).toBe(true);
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
              if (levels[currentLevel].score >= 4 && levels[currentLevel].unlocked) {
                if (currentLevel < levels.length - 1) {
                  currentLevel += 1;
                  levels[currentLevel].score = 0;
                  levels[currentLevel].unlocked = false;
                } else {
                  mode = 'won';
                }
              }
            },
            runSmokeTest: () => {
              window.__GAME_TEST__.start();
              const completed = [];
              for (let index = 0; index < levels.length; index += 1) {
                const levelBefore = currentLevel;
                for (let frame = 0; frame < 2; frame += 1) {
                  window.__GAME_TEST__.step({ ArrowRight: true }, 1);
                  window.__GAME_TEST__.step({ ArrowRight: true, Space: true }, 1);
                }
                if (levelBefore === index && (currentLevel > index || mode === 'won')) {
                  completed.push(index);
                }
              }
              return {
                passed: completed.length === levels.length && mode === 'won',
                checks: ['full campaign progression verified through shared step'],
                failures: [],
                coverage: {
                  levelsPassed: completed,
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
