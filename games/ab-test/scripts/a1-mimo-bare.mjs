// A1: Mimo 裸写单 HTML（baseline）
// system prompt 复用 code-agent 现有 platformer-game SKILL.md 的关键约束
import fs from 'node:fs/promises';
import path from 'node:path';
import { callMimo, stripCodeFence, USER_PROMPT } from './shared.mjs';

const SYSTEM_PROMPT = `You are a senior game developer. Produce a SELF-CONTAINED single-file HTML platformer game.

# Output Format (STRICT)
- Output ONE complete HTML document, starting with <!DOCTYPE html> and ending with </html>.
- No markdown, no code fences, no commentary before or after.
- All CSS and JavaScript MUST be inline. No external scripts, no CDN imports.
- The page MUST be playable by opening the file in a browser (file://) — no build step.

# Genre Conventions (Platformer)
- Side-scrolling 2D platformer with HTML5 Canvas.
- Physics: acceleration / friction, gravity, jump buffering or coyote time.
- Input: ← → for horizontal move, Space or ↑ for jump.
- Canvas must scale to viewport with max-width / max-height / aspect-ratio so narrow windows do not crop the playfield.
- First screen must show actor, controls, feedback, reward/risk. HUD shows score, health, objectives, win/fail state, progression across the 3 levels.

# Required Gameplay Mechanics (ALL must work end-to-end)
- stompable enemies: jumping ON TOP marks the enemy defeated AND bounces player.vy upward.
- bumpable question blocks: hitting from BELOW marks the block "used" and spawns the ability reward.
- a movement ability acquired from bumping the question block (must be doubleJump for this prompt).
- an ability-gated route: there must be a higher-up path that is UNREACHABLE before doubleJump and REACHABLE after.
- one comboChallenge: a section that requires combining jump with at least two of stomp/bump/ability/gate.

# Hidden contract (place in <script>):
\`\`\`js
window.__GAME_META__ = {
  artifactKind: 'game',
  subtype: 'platformer',
  gameplayMechanics: {
    enemies: [/* { stompable: true, defeatReward: '...' } */],
    blocks:  [/* { bumpableFromBelow: true, reward: 'doubleJump', usedState: 'bumped' } */],
    abilities: [/* { name: 'doubleJump', acquiredFrom: 'block', effect: 'movement', unlocksRoute: 'highRoute' } */],
    gates: [/* { requiresAbility: 'doubleJump', blocksAccessTo: 'highRoute' } */],
    comboChallenge: [/* { requires: ['jump','stomp','doubleJump'], target: 'reach exit' } */]
  }
};
window.snapshot = () => ({
  player: { x: player.x, y: player.y, vx: player.vx, vy: player.vy },
  enemiesDefeated, blocksUsed, gatesUnlocked,
  abilities: { doubleJump: !!abilities.doubleJump }
});
\`\`\`

# Art Style
- Stickman protagonist, black line-art cartoon style. NOT a thin generic stick — clearly recognizable cartoon stickman with head circle, body line, four limbs animated when moving/jumping.
- Backgrounds and platforms should look like a real game, not a wireframe diagram.
- Use simple but distinct colors per level (e.g. forest / cave / sky).

# Required UI
- HUD top-left: score, lives, current level, abilities owned.
- Win/lose screens with restart prompt.
- Death = respawn at level start; complete all 3 levels = win screen.

Produce the complete game now. Output ONLY the HTML document, nothing else.`;

async function main() {
  console.log('[A1] Calling Mimo (mimo-v2.5-pro, single HTML, streaming)...');
  const { content, reasoning, usage, finishReason, elapsedMs, chunks } = await callMimo({
    system: SYSTEM_PROMPT,
    user: USER_PROMPT,
    maxTokens: 32768,
    timeout: 900_000,
    onProgress: (p) => process.stdout.write(`\r[A1]  streaming content=${p.contentLen} reasoning=${p.reasoningLen}    `),
  });
  console.log('');

  const html = stripCodeFence(content, 'html');
  const outDir = path.resolve(import.meta.dirname, '..', 'a1-mimo-bare');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf8');
  if (reasoning) await fs.writeFile(path.join(outDir, 'mimo-reasoning.txt'), reasoning, 'utf8');
  await fs.writeFile(
    path.join(outDir, 'mimo-meta.json'),
    JSON.stringify({ usage, elapsedMs, chunks, finishReason, contentLength: content.length, reasoningLength: reasoning.length }, null, 2),
    'utf8',
  );

  console.log(`[A1] OK. elapsed=${(elapsedMs / 1000).toFixed(1)}s finish=${finishReason} content=${content.length} reasoning=${reasoning.length}`);
  console.log(`[A1] usage=${JSON.stringify(usage)}`);
  console.log(`[A1] Saved to ${outDir}/index.html (${html.length} chars)`);
}

main().catch((e) => {
  console.error('[A1] FAIL:', e.message);
  process.exit(1);
});
