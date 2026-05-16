// A1-v2: Mimo 裸写单 HTML — 拆 3 段调用规避 thinking 失控
// 段 1: HTML+CSS+DOM 骨架（无 JS）
// 段 2: Game 类（Player/Enemy/Block/Level/Particle）
// 段 3: 关卡数据 + 主循环 + boot
// 拼装: 把段 2+3 注入段 1 的 </body> 之前
import fs from 'node:fs/promises';
import path from 'node:path';
import { callMimo } from './shared.mjs';

const COMMON_GAMEMETA = `// Hidden game-meta contract (place at end of <script>):
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
window.snapshot = () => ({
  player: { x: player.x, y: player.y, vx: player.vx, vy: player.vy },
  enemiesDefeated, blocksUsed, gatesUnlocked,
  abilities: { doubleJump: !!player.abilities.doubleJump }
});`;

// ====== Segment 1: HTML + CSS + DOM scaffold ======
const SEG1_SYS = `You are a senior frontend developer. Output ONLY raw HTML (no markdown fences, no commentary, no <script> tags). The output must start with <!DOCTYPE html> and end with </html>.`;
const SEG1_USER = `Write the HTML scaffold for a 2D stickman platformer game. Requirements:
- <canvas id="game" width="960" height="540"> centered, full-viewport black background
- Inline CSS only: canvas with max-width:100%, aspect-ratio:16/9, height:auto so narrow windows do not crop
- HUD top-left: #hud-score, #hud-lives, #hud-level, #hud-ability (white text, sans-serif)
- Overlays #title-screen, #game-over-screen, #victory-screen — fixed full-screen semi-transparent panels with bold centered text
- Title screen text: "STICKMAN PLATFORMER" + "← → MOVE, SPACE/↑ JUMP, R RESTART" + "press SPACE to start"
- Death overlay: "YOU DIED — press R to retry"
- Win overlay: "VICTORY — you cleared 3 levels"
- DO NOT include any <script> tags or JavaScript. Pure markup + CSS.
- ~100 lines total.`;

// ====== Segment 2: Game classes ======
const SEG2_SYS = `You are a senior JavaScript engineer. Output ONLY JavaScript class definitions and helper functions. No markdown fences, no commentary, no main loop, no DOM access, no event listeners.`;
const SEG2_USER = `Write JS class definitions for a 2D platformer (no module imports, no main loop, no DOM):

class Player:
  - constructor(x, y)
  - props: x, y, vx, vy, width=20, height=40, abilities={doubleJump:false}, jumpsRemaining=1, grounded, coyoteTimer, jumpBufferTimer, alive, score, lives
  - methods: update(dt, input, level) — handles horizontal accel(800)/friction(0.85), gravity(2000), coyoteTime(0.1), jumpBufferTime(0.1), platform collision (uses level.platforms)
  - method: jump() — adds vy=-650; if doubleJump owned and !grounded, allow second jump
  - method: tryStompOrCollideEnemy(enemy) — if vy>0 and approaching from above, kill enemy and bounce vy=-400, else takeDamage
  - method: tryBumpBlock(block) — if vy<0 and hitting block from below and !block.used, mark block.used=true and grant doubleJump
  - render(ctx) — draws black-line cartoon stickman: head circle radius 6, body line, two arm lines, two leg lines. Limbs sway when |vx|>50, both legs forward when vy<0 (jumping). NOT a single vertical stroke.

class Enemy:
  - constructor(x, y, patrolMinX, patrolMaxX), props: x,y,vx=60,width=24,height=28,alive=true
  - update(dt) — patrols between patrolMinX/patrolMaxX
  - render(ctx) — red-line stickman variant, smaller

class Block:
  - constructor(x, y, size=32), props: used=false
  - render(ctx) — golden "?" tile while !used, dim gray "U" tile when used

class Level:
  - constructor(data) — data has {bg:hexColor, platforms:[{x,y,w,h}], enemies:[...], blocks:[...], gate:{x,y,w,h}, exit:{x,y,w,h}, spawn:{x,y}}
  - properties propagated as own fields
  - render(ctx) — fill bg, draw platforms as rounded rects, gate as locked door (red bar) if !this.gateUnlocked else open

class ParticleBurst { constructor(x,y,color), update(dt), render(ctx) — fire-and-forget burst on stomp/bump }

Use clear ES2020 class syntax. No 'export', no module imports. ~250 lines total.`;

// ====== Segment 3: levels + main loop + boot ======
const SEG3_SYS = `You are a senior JavaScript engineer. Output ONLY JavaScript code (no markdown fences, no commentary). Assume classes Player, Enemy, Block, Level, ParticleBurst already exist in this scope. Assume DOM elements #game, #hud-score, #hud-lives, #hud-level, #hud-ability, #title-screen, #game-over-screen, #victory-screen exist.`;
const SEG3_USER = `Write the game runtime layer:

1. Define LEVELS = [level1, level2, level3] arrays of plain data (background colors: forest #2c5f2d / cave #4b3869 / sky #4f86c6).
   - Level 1: 3 platforms, 2 patrol enemies, 1 question-block above first gap. Spawn left-low. Exit right-low. No gate. Goal: stomp + reach exit.
   - Level 2: Has a high platform unreachable without doubleJump. 1 question-block (grants doubleJump). 1 gate at mid (requires doubleJump). Exit on high platform.
   - Level 3: comboChallenge — sequence requires (a) stomp first enemy, (b) bump block to ensure doubleJump retained, (c) double-jump over wide gap, (d) clear gate, (e) reach exit. Multiple enemies and platforms.

2. Game state (top-level vars): currentLevelIndex=0, level=new Level(LEVELS[0]), player, enemies, blocks, particles=[], enemiesDefeated=0, blocksUsed=0, gatesUnlocked=0, screen='title', lastTime=0.

3. Input handling — keydown/keyup tracks {left,right,jump,restart}. Space and ArrowUp both map to jump. R maps to restart. On title screen Space starts game.

4. startLevel(idx), respawn(), advanceLevel(), restartGame() helpers.

5. Main loop: requestAnimationFrame(loop), dt clamped to 1/30. While screen==='play': update player, enemies, blocks, particles; resolve collisions (enemy stomp/contact damage; block bump from below; gate open if player has doubleJump and touches; exit triggers advanceLevel). Update HUD text. Trigger death/victory overlay state.

6. Render order: level → blocks → enemies → player → particles. Overlay screens via CSS display toggling.

7. ${COMMON_GAMEMETA}

8. Boot: window.addEventListener('load', () => { startLevel(0); requestAnimationFrame(loop); });

No 'export' or modules. ~350 lines total.`;

async function streamCall(label, sys, user, maxTokens) {
  console.log(`[A1-v2] [${label}] calling mimo...`);
  const r = await callMimo({
    system: sys, user: user, maxTokens, timeout: 240_000,
    onProgress: (p) => process.stdout.write(`\r[A1-v2] [${label}] content=${p.contentLen} reasoning=${p.reasoningLen}    `),
  });
  console.log('');
  console.log(`[A1-v2] [${label}] done: finish=${r.finishReason} content=${r.content.length} reasoning=${r.reasoning.length} elapsed=${(r.elapsedMs/1000).toFixed(1)}s`);
  if (r.finishReason === 'length') console.warn(`[A1-v2] [${label}] WARN: output truncated`);
  return r;
}

function stripFences(text) {
  return text.trim().replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
}

async function main() {
  const outDir = path.resolve(import.meta.dirname, '..', 'a1-mimo-bare');
  await fs.mkdir(outDir, { recursive: true });

  // 串行调用避免端点压力（也方便排错）
  const r1 = await streamCall('seg1-html', SEG1_SYS, SEG1_USER, 6000);
  const r2 = await streamCall('seg2-classes', SEG2_SYS, SEG2_USER, 8000);
  const r3 = await streamCall('seg3-runtime', SEG3_SYS, SEG3_USER, 8000);

  await fs.writeFile(path.join(outDir, 'seg1-raw.txt'), r1.content);
  await fs.writeFile(path.join(outDir, 'seg2-raw.txt'), r2.content);
  await fs.writeFile(path.join(outDir, 'seg3-raw.txt'), r3.content);

  let html = stripFences(r1.content);
  if (!/<\/body>/i.test(html)) {
    // 兜底: 用 </html> 也行
    if (/<\/html>/i.test(html)) {
      html = html.replace(/<\/html>/i, '</body></html>');
    } else {
      html += '\n</body></html>';
    }
  }
  const js2 = stripFences(r2.content);
  const js3 = stripFences(r3.content);
  const combinedScript = `<script>\n${js2}\n\n${js3}\n<\/script>\n`;
  html = html.replace(/<\/body>/i, `${combinedScript}</body>`);

  await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf8');
  const totalReasoning = r1.reasoning.length + r2.reasoning.length + r3.reasoning.length;
  const totalElapsed = r1.elapsedMs + r2.elapsedMs + r3.elapsedMs;
  await fs.writeFile(path.join(outDir, 'mimo-meta.json'), JSON.stringify({
    strategy: '3-segment split (HTML / classes / runtime)',
    segments: [
      { name: 'seg1-html',     finish: r1.finishReason, content: r1.content.length, reasoning: r1.reasoning.length, elapsedMs: r1.elapsedMs, usage: r1.usage },
      { name: 'seg2-classes',  finish: r2.finishReason, content: r2.content.length, reasoning: r2.reasoning.length, elapsedMs: r2.elapsedMs, usage: r2.usage },
      { name: 'seg3-runtime',  finish: r3.finishReason, content: r3.content.length, reasoning: r3.reasoning.length, elapsedMs: r3.elapsedMs, usage: r3.usage },
    ],
    totalReasoningChars: totalReasoning,
    totalElapsedMs: totalElapsed,
    finalHtmlBytes: html.length,
  }, null, 2));

  console.log(`\n[A1-v2] DONE. ${html.length} byte HTML written. total elapsed=${(totalElapsed/1000).toFixed(1)}s`);
}

main().catch((e) => { console.error('[A1-v2] FAIL:', e.message); process.exit(1); });
