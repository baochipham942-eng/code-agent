// A2: Mimo + OpenGame 模板约束 → 输出 Vite/Phaser 项目 src/ 文件清单
// 注：package.json / vite.config.js / index.html / tsconfig 等 bootstrap 已预置（不算 Mimo 生成）
//     Mimo 只负责输出 src/ 下所有文件
import fs from 'node:fs/promises';
import path from 'node:path';
import { callMimo, stripCodeFence, USER_PROMPT, writeJsonFiles } from './shared.mjs';

const SYSTEM_PROMPT = `You are a senior game developer working on a Vite + Phaser 3 (3.90.0) TypeScript project.

# Output Format (STRICT)
Output ONE JSON object — no markdown fences, no commentary, no leading/trailing text.
Schema:
{
  "files": [
    { "path": "src/main.ts", "content": "// full file contents..." },
    { "path": "src/scenes/Level1Scene.ts", "content": "..." },
    ...
  ]
}
- Every path MUST start with "src/".
- Every content MUST be the COMPLETE file contents, valid TypeScript that compiles with strict mode.
- Use double-escaped newlines (\\n) in content strings since this is JSON.
- Output VALID JSON only. No trailing commas. No comments outside the content strings.

# Bootstrap (ALREADY PROVIDED — DO NOT EMIT)
The following files exist; you must NOT include them in your output:
- package.json (phaser 3.90.0, vite 6.2, typescript 5.8)
- vite.config.js (dev server on :8080, alias phaser→phaser/dist/phaser.js)
- index.html (mounts <script type="module" src="/src/main.ts"></script> into <div id="game-container">)
- tsconfig.json, postcss.config.js, tailwind.config.js

# Project Structure (Template Skill convention)
src/
  main.ts                # Phaser config + register ALL scenes via game.scene.add()
  LevelManager.ts        # exports LEVEL_ORDER array (level scene keys)
  gameConfig.json        # playerConfig (walkSpeed, jumpPower, doubleJumpPower), enemyConfig, blockConfig
  StateMachine.ts        # generic FSM helper (you implement)
  utils.ts               # platformer utilities (you implement)
  scenes/
    Preloader.ts         # Generate sprite textures procedurally via Phaser Graphics (NO PNG dependency).
                         #   Required generated textures: stickman_idle, stickman_run, stickman_jump,
                         #   enemy_walker, qblock_full, qblock_used, platform_tile, gate_locked, gate_open.
                         #   Use scene.add.graphics(), draw shapes, .generateTexture(key, w, h), .destroy().
    TitleScreen.ts       # Shows controls + "Press Space" → navigates to LEVEL_ORDER[0]
    BaseLevelScene.ts    # Abstract base: setupMapSize/createBackground/createTileMap/createPlayer/createEnemies hooks
    Level1Scene.ts       # Level 1 (no double jump yet, but has question block to grant it)
    Level2Scene.ts       # Level 2 (double jump unlocked, gated high route required)
    Level3Scene.ts       # Level 3 (comboChallenge: chain stomp + bump + double jump + gate to exit)
    UIScene.ts           # HUD overlay (score, lives, current level, abilities owned)
    GameOverScene.ts
    VictoryScene.ts
  characters/
    BasePlayer.ts        # Phaser.Physics.Arcade.Sprite subclass, health, takeDamage(), onDamageTaken hook
    Stickman.ts          # extends BasePlayer, runs PlatformerMovement behavior, holds abilities
    BaseEnemy.ts         # stompable on top, contact damage on side
    StickEnemy.ts        # extends BaseEnemy, patrol AI
  behaviors/
    PlatformerMovement.ts # walkSpeed, jumpPower, coyoteTime, jumpBufferTime, doubleJumpEnabled, doubleJumpPower

# Required Gameplay Mechanics (ALL must work end-to-end)
- stompable enemies: jump ON TOP marks enemy defeated AND bounces player.body.velocity.y upward.
- bumpable question blocks: hit FROM BELOW marks block used AND spawns ability reward (doubleJump).
- doubleJump ability: acquired from bumping question block. Before acquisition, only one jump.
- ability-gated route: a higher platform must be UNREACHABLE before doubleJump and REACHABLE after.
- comboChallenge in Level 3: a section requiring jump + stomp + doubleJump + gate clearance in sequence to reach exit.

# Hidden game-meta contract (emit in main.ts after Phaser.Game creation):
window.__GAME_META__ = {
  artifactKind: 'game',
  subtype: 'platformer',
  gameplayMechanics: {
    enemies: [{ stompable: true, defeatReward: 'score' }],
    blocks:  [{ bumpableFromBelow: true, reward: 'doubleJump', usedState: 'bumped' }],
    abilities: [{ name: 'doubleJump', acquiredFrom: 'block', effect: 'movement', unlocksRoute: 'highRoute' }],
    gates: [{ requiresAbility: 'doubleJump', blocksAccessTo: 'highRoute' }],
    comboChallenge: [{ requires: ['jump','stomp','doubleJump'], target: 'reach exit in level 3' }]
  }
};
Also expose window.snapshot() returning { player, enemiesDefeated, blocksUsed, gatesUnlocked, abilities }.

# Procedural Sprite Drawing (CRITICAL — no PNG dependency)
- In Preloader.ts, for each required texture key, use this exact pattern:
    const g = this.add.graphics();
    g.lineStyle(3, 0x000000, 1);
    g.fillStyle(0xffffff, 1);
    // ... draw shapes for stickman head circle, body line, four limbs ...
    g.generateTexture('stickman_idle', 48, 64);
    g.destroy();
- Stickman style: black-line cartoon stickman on white/transparent background. Head circle ~12px radius,
  body line down, two arm lines, two leg lines. Idle/run/jump variants differ in limb angle.
- NOT a thin generic stick — clearly recognizable cartoon stickman.

# Debug Protocol (Pre-Build Checklist — enforce in code)
- ALL scene keys passed to scene.start() MUST be registered in main.ts.
- LevelManager.LEVEL_ORDER[0] MUST match the first registered level scene key (NOT a placeholder).
- ALL texture keys used in this.add.image() / this.add.sprite() MUST be generated in Preloader.
- import { type X } syntax for ALL TypeScript interfaces/types (verbatim — strict mode requires this).
- NEVER call this.scene.start() inside the scene's create() callback before Phaser finishes scene boot.
  Use this.time.delayedCall(0, () => this.scene.start(...)) if needed at boot end.
- Phaser Containers have NO implicit hitArea. setInteractive() on inner shapes only.
- Reset per-scene mutable state inside create() — Phaser reuses scene instances when restarted.

# Input
- ← → for horizontal move
- Space or ↑ for jump (second press triggers double jump if ability owned)
- R to restart current level on death

# Art / Polish
- Stickman protagonist with clear cartoon limbs (NOT a thin line)
- 3 levels with visually distinct color palettes (e.g. forest green / cave purple / sky blue)
- HUD top-left: score, lives, level, abilities. Win screen and death/respawn flow.

Produce the complete project src/ now. Output ONLY the JSON object, nothing else.`;

async function main() {
  console.log('[A2] Calling Mimo (mimo-v2.5-pro, Phaser project JSON, streaming)...');
  const { content, reasoning, usage, finishReason, elapsedMs, chunks } = await callMimo({
    system: SYSTEM_PROMPT,
    user: USER_PROMPT,
    maxTokens: 32768,
    timeout: 900_000,
    onProgress: (p) => process.stdout.write(`\r[A2]  streaming content=${p.contentLen} reasoning=${p.reasoningLen}    `),
  });
  console.log('');

  const outDir = path.resolve(import.meta.dirname, '..', 'a2-mimo-opengame');
  await fs.mkdir(outDir, { recursive: true });

  // 先保存原始返回以便排错
  await fs.writeFile(path.join(outDir, 'mimo-raw.txt'), content, 'utf8');
  if (reasoning) await fs.writeFile(path.join(outDir, 'mimo-reasoning.txt'), reasoning, 'utf8');
  await fs.writeFile(
    path.join(outDir, 'mimo-meta.json'),
    JSON.stringify({ usage, elapsedMs, chunks, finishReason, contentLength: content.length, reasoningLength: reasoning.length }, null, 2),
    'utf8',
  );
  console.log(`[A2] stream done. elapsed=${(elapsedMs / 1000).toFixed(1)}s finish=${finishReason} content=${content.length} reasoning=${reasoning.length}`);

  // strip fence + parse
  const stripped = stripCodeFence(content, 'json');
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    // 容错：尝试找第一个 { 到最后一个 } 之间的内容
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
        console.warn('[A2] JSON fallback extraction succeeded');
      } catch (e2) {
        throw new Error(`Mimo returned invalid JSON: ${e.message}; raw saved to mimo-raw.txt`);
      }
    } else {
      throw new Error(`Mimo returned no JSON braces; raw saved to mimo-raw.txt`);
    }
  }

  const files = parsed.files || [];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files[] in Mimo output');
  }

  // 安全检查：所有 path 必须 src/ 开头，禁止逃逸
  for (const f of files) {
    if (typeof f.path !== 'string' || !f.path.startsWith('src/') || f.path.includes('..')) {
      throw new Error(`Bad path: ${f.path}`);
    }
    if (typeof f.content !== 'string') {
      throw new Error(`Bad content for ${f.path}`);
    }
  }

  await writeJsonFiles(outDir, files);

  console.log(`[A2] OK. elapsed=${(elapsedMs / 1000).toFixed(1)}s tokens=${JSON.stringify(usage)}`);
  console.log(`[A2] Wrote ${files.length} files to ${outDir}/src/`);
  for (const f of files) console.log(`  - ${f.path} (${f.content.length} chars)`);
}

main().catch((e) => {
  console.error('[A2] FAIL:', e.message);
  process.exit(1);
});
