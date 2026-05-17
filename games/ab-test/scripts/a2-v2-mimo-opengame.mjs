// A2-v2: Mimo + OpenGame 模板 → 拆 6 次调用生成 Vite/Phaser 项目
// 每次只让 mimo 输出 1-2 个文件 (返回 JSON: { files: [{path, content}] })
// 前置: bootstrap (package.json/vite.config.js/index.html/tsconfig.json) 已预置
import fs from 'node:fs/promises';
import path from 'node:path';
import { callMimo, writeJsonFiles } from './shared.mjs';

const SHARED_RULES = `# Output format
Output ONE JSON object, no markdown fences, no commentary:
{ "files": [ { "path": "src/...", "content": "..." } ] }
- Every "path" MUST start with "src/" and be one of the requested files in this turn.
- "content" is the COMPLETE file content, valid TypeScript (or JSON for .json files) under strict mode.
- Use JSON-escaped newlines (\\n) inside content strings.

# Stack & conventions
- Vite + Phaser 3.90.0 + TypeScript 5.8, ES2022 modules.
- import { type X } syntax for ALL type-only imports (verbatim, strict).
- All assets are generated PROCEDURALLY in Preloader via scene.add.graphics().generateTexture(); NO .png loading.
- Texture keys (must match across files): stickman_idle, stickman_run, stickman_jump, enemy_walker, qblock_full, qblock_used, platform_tile, gate_locked, gate_open, exit_flag.
- Coordinate convention: world units = pixels; gravity 800; player walk 200; jump -500; double jump (when owned) gives a second -450 on key-press.

# Project structure (you will fill across 6 turns)
src/main.ts                # phaser config, register scenes (Preloader, TitleScene, Level1, Level2, Level3, UIScene, GameOver, Victory), set window.__GAME_META__ + window.snapshot
src/LevelManager.ts        # exports LEVEL_ORDER = ['Level1','Level2','Level3']
src/gameConfig.json        # tunable numbers (walkSpeed, jumpPower, doubleJumpPower, gravity)
src/scenes/Preloader.ts    # draw all texture keys via Graphics
src/scenes/TitleScene.ts   # press SPACE → scene.start(LEVEL_ORDER[0])
src/scenes/BaseLevelScene.ts # abstract: setupMap/createPlayer/createEnemies/createBlocks/createGates/createExit hooks
src/scenes/Level1Scene.ts  # intro, 3 platforms, 2 enemies, 1 question block above first gap, no gate, exit on ground right
src/scenes/Level2Scene.ts  # qblock grants doubleJump, gate mid (requires doubleJump), exit on high platform
src/scenes/Level3Scene.ts  # comboChallenge: chain stomp/bump/doubleJump/gate to exit
src/scenes/UIScene.ts      # HUD overlay (score, lives, level, abilities)
src/scenes/GameOverScene.ts# death overlay, R or Space to retry
src/scenes/VictoryScene.ts # win overlay after clearing 3 levels
src/characters/Stickman.ts # arcade sprite, draws stickman cartoon limbs, abilities, lives
src/characters/StickEnemy.ts # patrol AI, stompable from above

# Stickman style (CRITICAL)
- Black-line cartoon: head circle (radius 6-7), body line, two arms, two legs. Limbs sway when running, both legs forward on jump. NOT a thin generic vertical line.
- Procedural drawing in Preloader: scene.add.graphics().lineStyle(3, 0x000000).strokeCircle(...)...generateTexture('stickman_idle', 28, 48).destroy()`;

const HIDDEN_GAMEMETA = `In main.ts after creating the Phaser.Game instance, set:
window.__GAME_META__ = {
  artifactKind: 'game', subtype: 'platformer',
  gameplayMechanics: {
    enemies: [{ stompable: true, defeatReward: 'score' }],
    blocks:  [{ bumpableFromBelow: true, reward: 'doubleJump', usedState: 'bumped' }],
    abilities: [{ name: 'doubleJump', acquiredFrom: 'block', effect: 'movement', unlocksRoute: 'highRoute' }],
    gates: [{ requiresAbility: 'doubleJump', blocksAccessTo: 'highRoute' }],
    comboChallenge: [{ requires: ['jump','stomp','doubleJump'], target: 'reach exit of level 3' }]
  }
};
And expose window.snapshot = () => ({ player: { x, y, vx: body.velocity.x, vy: body.velocity.y }, enemiesDefeated, blocksUsed, gatesUnlocked, abilities: { doubleJump: !!gameState.abilities.doubleJump } });
where gameState is a singleton kept on window.gameState (also expose globalThis.gameState).`;

const TURNS = [
  {
    name: 'turn1-main',
    files: ['src/main.ts', 'src/LevelManager.ts', 'src/gameConfig.json'],
    maxTokens: 6500,
    extra: `Generate src/main.ts (Phaser game config 960x540, physics.arcade with gravity 800, registers Preloader+TitleScene+Level1Scene+Level2Scene+Level3Scene+UIScene+GameOverScene+VictoryScene, first scene='Preloader'),
src/LevelManager.ts (export const LEVEL_ORDER = ['Level1','Level2','Level3']),
src/gameConfig.json (numeric tuning constants).

${HIDDEN_GAMEMETA}`,
  },
  {
    name: 'turn2-preloader',
    files: ['src/scenes/Preloader.ts'],
    maxTokens: 8000,
    extra: `Generate src/scenes/Preloader.ts (Phaser.Scene with key='Preloader').
In create(), for EACH texture key listed below, call:
  const g = this.add.graphics(); g.lineStyle(3, 0x000000); ... draw ... g.generateTexture(KEY, W, H); g.destroy();
Required textures with sizes:
 - stickman_idle 28x48 — head circle + body line + arms hanging + legs straight
 - stickman_run  28x48 — same + arms forward/back + legs in stride
 - stickman_jump 28x48 — both legs forward, arms up
 - enemy_walker  32x32 — red-line shorter stickman with frown
 - qblock_full   32x32 — gold square + black "?" glyph
 - qblock_used   32x32 — gray square + black "·"
 - platform_tile 64x16 — brown tile with darker outline
 - gate_locked   24x64 — dark red bar with black lock
 - gate_open     24x64 — gold open frame
 - exit_flag     24x40 — pole + green pennant
After all textures drawn, this.scene.start('TitleScene').`,
  },
  {
    name: 'turn3-title-uioverlays',
    files: ['src/scenes/TitleScene.ts', 'src/scenes/UIScene.ts', 'src/scenes/GameOverScene.ts', 'src/scenes/VictoryScene.ts'],
    maxTokens: 7000,
    extra: `Generate 4 simple scene files:
 - TitleScene: black background, big text "STICKMAN PLATFORMER" + controls hint + "press SPACE". On Space → reset window.gameState (score 0, lives 3, abilities {doubleJump:false}, enemiesDefeated 0, blocksUsed 0, gatesUnlocked 0) and scene.start('Level1'); also this.scene.launch('UIScene').
 - UIScene: overlay scene with key='UIScene'. Reads window.gameState in update(), shows top-left text: Score, Lives, Level (current level scene key), Ability (doubleJump on/off). Updates every frame.
 - GameOverScene: dark overlay, "YOU DIED — press R or SPACE", restarts at current level.
 - VictoryScene: "VICTORY — you cleared 3 levels — press R to restart"; R restarts at Level1.
All scenes import LEVEL_ORDER from '../LevelManager'.`,
  },
  {
    name: 'turn4-base-and-level1',
    files: ['src/scenes/BaseLevelScene.ts', 'src/scenes/Level1Scene.ts'],
    maxTokens: 9000,
    extra: `Generate src/scenes/BaseLevelScene.ts — abstract Phaser.Scene that subclasses extend. Responsibilities:
 - In create(): build platforms group, enemies group, blocks group; create Stickman player; setup arcade collisions:
    - player vs platforms (collide)
    - player vs enemies (overlap → if player.body.velocity.y > 30 and player.y < enemy.y, stomp: enemy.disableBody, gameState.enemiesDefeated++, player.body.setVelocityY(-300); else takeDamage → respawn)
    - player vs blocks (overlap → if player.body.velocity.y < 0 and player.y > block.y, bump: block.setTexture('qblock_used'), block.used=true, gameState.blocksUsed++, gameState.abilities.doubleJump=true, player.unlockDoubleJump())
    - player vs gate (overlap → if gameState.abilities.doubleJump: gate.setTexture('gate_open'), gate.disableBody, gameState.gatesUnlocked++, else block movement)
    - player vs exit (overlap → call onExit() which starts next level or VictoryScene)
 - Abstract / overridable: setupMap(), createEnemies(), createBlocks(), createGates(), createExit().
 - input: left/right arrows for move, SPACE/UP for jump (jump first time always; second jump only if abilities.doubleJump && !player.usedDoubleJump in this airborne phase).
 - On player death: if gameState.lives > 0 → respawn at this.spawn; else scene.start('GameOverScene', {fromScene: this.scene.key}).

Generate src/scenes/Level1Scene.ts extending BaseLevelScene. setupMap: 3 platforms (ground-floor + 2 elevated). createEnemies: 2 patrol enemies on ground. createBlocks: 1 question block above the first gap (jumping height). NO gates. createExit on right side at ground level. Spawn at (60, 400). Next level → 'Level2'.

Both files together ~400 lines.`,
  },
  {
    name: 'turn5-level2-level3',
    files: ['src/scenes/Level2Scene.ts', 'src/scenes/Level3Scene.ts'],
    maxTokens: 9000,
    extra: `Generate Level2Scene and Level3Scene, both extend BaseLevelScene.

Level2Scene:
 - platforms include a HIGH platform (y around 120) unreachable without doubleJump
 - createBlocks: 1 question block at jump height granting doubleJump
 - createGates: 1 gate placed where player must traverse mid-route
 - createExit on the HIGH platform
 - 2-3 enemies in the path
 - Next level → 'Level3'

Level3Scene (comboChallenge):
 - layout requires the chain: stomp first enemy → bump second block (keeps doubleJump) → double-jump over a wide gap → clear gate → reach exit
 - 4-5 enemies, 2 blocks, 1 gate
 - Next: scene.start('VictoryScene')

Both files have the same import header and structure pattern. ~350 lines total.`,
  },
  {
    name: 'turn6-characters',
    files: ['src/characters/Stickman.ts', 'src/characters/StickEnemy.ts'],
    maxTokens: 7000,
    extra: `Generate two Arcade Sprite subclasses:

src/characters/Stickman.ts: class Stickman extends Phaser.Physics.Arcade.Sprite.
 - constructor(scene, x, y) — texture 'stickman_idle', add to scene/physics, setCollideWorldBounds(true), setSize(20, 44).
 - properties: usedDoubleJump=false, abilities (always read from window.gameState.abilities).
 - update(time, delta): reads scene cursors (this.scene.cursors), input.keyboard.checkDown for arrow keys; updates velocity (walkSpeed 200, friction handled by physics drag); switches texture stickman_idle/run/jump by state.
 - jump(): if blocked.down or !usedDoubleJump → set velocity.y. First jump always allowed when grounded (blocked.down). Second jump only if abilities.doubleJump && !usedDoubleJump && !blocked.down. After airborne second jump, set usedDoubleJump=true. On landing (blocked.down), reset usedDoubleJump.
 - unlockDoubleJump(): no-op (gameState.abilities mutated externally) — provided for symmetry.
 - takeDamage(scene): gameState.lives--; if (lives <= 0) scene.scene.start('GameOverScene'); else respawn at scene.spawn.

src/characters/StickEnemy.ts: class StickEnemy extends Phaser.Physics.Arcade.Sprite. Texture 'enemy_walker'. Constructor (scene, x, y, patrolMin, patrolMax). update(): horizontal patrol — bounce vx at patrolMin/patrolMax. ~120 lines.`,
  },
];

async function callTurn(turn) {
  const fileListing = turn.files.map((p) => `- ${p}`).join('\n');
  const system = `${SHARED_RULES}

# This turn's job
You will emit ONLY these files (others are out of scope):
${fileListing}`;
  const user = turn.extra;
  console.log(`\n[A2-v2] [${turn.name}] calling mimo for ${turn.files.length} file(s)...`);
  const r = await callMimo({
    system, user, maxTokens: turn.maxTokens, timeout: 240_000,
    onProgress: (p) => process.stdout.write(`\r[A2-v2] [${turn.name}] content=${p.contentLen} reasoning=${p.reasoningLen}    `),
  });
  console.log('');
  console.log(`[A2-v2] [${turn.name}] finish=${r.finishReason} content=${r.content.length} reasoning=${r.reasoning.length} elapsed=${(r.elapsedMs/1000).toFixed(1)}s`);
  if (r.finishReason === 'length') console.warn(`[A2-v2] [${turn.name}] WARN: output truncated`);
  return r;
}

function parseFiles(rawContent, turnName) {
  let txt = rawContent.trim();
  const fenceMatch = txt.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) txt = fenceMatch[1];
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (e) {
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a >= 0 && b > a) parsed = JSON.parse(txt.slice(a, b+1));
    else throw new Error(`[${turnName}] JSON parse failed: ${e.message}`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) throw new Error(`[${turnName}] no files[]`);
  for (const f of parsed.files) {
    if (typeof f.path !== 'string' || !f.path.startsWith('src/') || f.path.includes('..')) throw new Error(`bad path: ${f.path}`);
    if (typeof f.content !== 'string') throw new Error(`bad content for ${f.path}`);
  }
  return parsed.files;
}

async function main() {
  const outDir = path.resolve(import.meta.dirname, '..', 'a2-mimo-opengame');
  await fs.mkdir(outDir, { recursive: true });

  // 清理 src/ (avoid stale)
  const srcDir = path.join(outDir, 'src');
  try { await fs.rm(srcDir, { recursive: true, force: true }); } catch {}

  const segMeta = [];
  let allFiles = [];

  for (const turn of TURNS) {
    const r = await callTurn(turn);
    await fs.writeFile(path.join(outDir, `mimo-raw-${turn.name}.txt`), r.content);
    try {
      const files = parseFiles(r.content, turn.name);
      await writeJsonFiles(outDir, files);
      allFiles.push(...files.map((f) => f.path));
      console.log(`  -> wrote ${files.length} file(s): ${files.map(f=>f.path).join(', ')}`);
      segMeta.push({ name: turn.name, finish: r.finishReason, contentChars: r.content.length, reasoningChars: r.reasoning.length, elapsedMs: r.elapsedMs, usage: r.usage, files: files.map(f=>f.path) });
    } catch (e) {
      console.error(`  [!] ${turn.name} parse failed:`, e.message);
      segMeta.push({ name: turn.name, finish: r.finishReason, contentChars: r.content.length, reasoningChars: r.reasoning.length, elapsedMs: r.elapsedMs, usage: r.usage, parseError: e.message });
    }
  }

  await fs.writeFile(path.join(outDir, 'mimo-meta.json'), JSON.stringify({
    strategy: '6-turn split (main/preloader/ui/baseLevel+1/levels2+3/characters)',
    segments: segMeta,
    totalFiles: allFiles.length,
    files: allFiles,
  }, null, 2));

  console.log(`\n[A2-v2] DONE. ${allFiles.length} files written. Now run: cd a2-mimo-opengame && npm install && npm run build`);
}

main().catch((e) => { console.error('[A2-v2] FAIL:', e.message); process.exit(1); });
