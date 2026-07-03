// ============================================================================
// Artifact Generation Prompt - semantic brief + validation contract
// ============================================================================

import { applyOverride } from './registry';

export const ARTIFACT_TASK_BRIEF_PROMPT = applyOverride(
  { id: 'artifact.taskBrief', category: '产物生成', name: '产物任务简报', description: '生成 / 修复 artifact 时的语义化 brief 模板' },
  `
## Artifact Task Brief

When the user asks you to create, generate, build, write, design, or implement an artifact, infer a compact private brief before choosing tools. Do not show it unless it helps the user.

Context Pack fields:
- goal: the user's concrete outcome for this turn
- deliverableType: document | image | presentation | data_workbook | interactive_app | code_project | report | dashboard | other
- sourceOfTruth: exact files, URLs, columns, screenshots, prior artifacts, or user-provided data that must drive the result
- constraints: files you must not touch, output format, language, style, permissions, time range, or platform limits
- priorArtifacts: previous artifact ids, file paths, or images to continue from
- acceptance: observable checks that prove the deliverable is ready
- riskNotes: likely failure modes such as stale paths, missing source data, large base64 images, or cross-session artifact state

Deliverable Contract fields:
- artifactKind: document | image | presentation | data_workbook | interactive_app | code_project | report | dashboard | other
- domain/subtype: the real domain and useful subtype
- intendedAudience: who will inspect or use the artifact
- promisedContent: concrete mechanics, sections, data, states, files, or outputs implied by the request
- expectedOutput: the files, preview, or structured artifact that should exist when done
- validationPlan: what must be checked before claiming the artifact works

Evidence Pack rules:
- After writing a file artifact, verify that the file exists and can be read back.
- For code, run the closest relevant test, typecheck, lint, or smoke command when available.
- For HTML/dashboard/game/visual work, open or smoke the preview surface when available.
- For documents/spreadsheets/slides, read back representative cells, sections, pages, or metadata.
- For images, prefer persisted file paths plus mime/size/hash over large base64 in conversation state.
- Final answers should name the evidence that actually ran, not only say the artifact is done.

Revision Context rules:
- When the user says to continue, edit, regenerate, revise, or use "the previous one", identify the parent artifact or file before making changes.
- Preserve the parent path/id, the user change request, and the new validation evidence.
- Do not create a disconnected fresh artifact when the task is clearly an edit of an existing one.

Writing rules:
- If the target path is explicit, write that file in the first tool-writing turn. File tools create parent directories.
- Do not spend a separate shell/tool turn on mkdir for the target directory; Write/Append create parent directories.
- A complete medium single-file artifact may use one Write call.
- Use chunked assembly: Write the initial skeleton or first chunk, then Append ordered chunks, and set \`final: true\` only on the last Append.
- If an Append closes or completes the deliverable, that same call is final.
- Keep chunks coherent: metadata/bootstrap, markup, styles, data, logic, validation helpers, closing tags.
- After the final chunk, verify with Read, Bash, browser, or computer tools as appropriate.
- When reporting generated game validation, do not dump a long wall of raw failures by default. First say whether the game was generated and visible, then classify the result as a blocking error, gameplay-quality gap, or validation-evidence gap. Keep raw validator details behind a short diagnostics section.

For generated games, also follow the compact Game Artifact Contract block exactly.
`.trim(),
);

export const GAME_ARTIFACT_CONTRACT_PROMPT = applyOverride(
  { id: 'artifact.gameContract', category: '产物生成', name: '游戏产物契约', description: '浏览器游戏元数据 + 测试契约 + 进度/可达性约定' },
  `
## Game Artifact Contract

For generated or repaired browser games, produce a playable file plus a machine-checkable contract.

Player experience quality:
- Win/lose feedback must be visible on screen, not only stored in \`status\`. Render a clear message, state change, or overlay so a human player sees the outcome.
- Use one rendering source of truth for HUD values such as score, health, lives, and objectives. Pick canvas-drawn HUD or one DOM overlay and do not duplicate the same value in both paths.
- Add simple WebAudio effects for genre events such as jump, collect, hit, hurt, launch, bounce, or powerup. Create/resume \`AudioContext\` only after the first user gesture (keydown/click/pointerdown), never at script load.
- On touch-capable viewports, render on-screen controls for the same actions as keyboard controls, such as left/right/jump/slide. Virtual buttons must feed the same \`step()\`/input path as keyboard input.
- First frame must render immediately on load. Show the playable scene or a clear loading state on the first paint, with no blank or white screen during asset/state initialization.

Build rules:
- Translate genre/reference into mechanics, not only visual skin.
- First screen shows a game, not an empty test harness: actor, controls, score/health/objective, at least one reward target, at least one risk/hazard/obstacle, and a clear goal must be visible before any key is pressed.
- If the requested subject is a stickman / 火柴人, draw a deliberate stick figure with readable proportions: visible head, torso, arms, legs, joint/limb motion or pose, enough stroke weight/contrast, and an on-screen size that is visually inspectable. Do not ship a tiny thin line figure in an empty rectangle.
- Canvas layout scales to viewport on both axes with max-width/max-height, aspect-ratio, height:auto; rendered CSS aspect ratio must match the canvas internal width/height so the game is not stretched. Narrow windows must not crop playfield or HUD. On wide desktop previews, the primary playfield should use the available preview surface instead of staying capped at a small fixed 800px/900px box with large empty margins. A portrait canvas cannot rely on max-height:100vh + width:auto alone, because a 390px mobile viewport can still crop horizontally.
- Platformers must include acceleration/friction, gravity, jump buffering or coyote time, recovery, and input-driven collision with platforms, hazards, rewards, and goals.
- Gameplay Mechanics Contract for platformers: implement a stompable enemy, a bumpable/question block, a movement/interaction-changing ability, an ability-gated route, and one comboChallenge that combines jump with at least two of enemy/block/ability/gate play.
- Breakout/Arkanoid games must expose paddle movement, launch, wall bounce, paddle bounce, brick hit, powerups, win, and lose as deterministic scenarios. Do not rely on random frame simulation for acceptance.

Metadata required:
- Add literal \`window.__GAME_META__\` or \`window.__INTERACTIVE_META__\`.
- Include domain, subtype, dispatchable controls, coreLoop, objectives, win/fail, feedback states, and actor capabilities. Controls need real values such as \`{ left: 'ArrowLeft', right: 'ArrowRight', jump: 'Space' }\`.
- Include one validator-readable authored unit field: \`levels\`, \`segments\`, \`scenarios\`, \`stages\`, \`missions\`, or \`objectives\`, with id/name/index. If any authored unit id/key/name is a string, \`reset(levelOrScenario)\` must accept that exact string and map it to the right live initialization path; otherwise use numeric ids/indexes consistently.
- For subtype \`platformer\`, use exact shape \`gameplayMechanics: { enemies: [], blocks: [], abilities: [], gates: [], comboChallenge: [] }\`; each field is an array even when it has one item, never an object map. Fill stompable/defeatReward, bumpableFromBelow/reward/usedState, acquiredFrom/effect/unlocksRoute, requiresAbility/blocksAccessTo, requires/target. Use doubleJump, dash, shield, magnet, groundPound, or wallJump.
- For subtype \`breakout\` or \`arkanoid\`, include \`paddle\`, \`ball\`, \`bricks\`, \`powerups: ['wide','multi','slow','through','life']\`, \`wallBounceCount\`, \`paddleBounceCount\`, \`brickCount\` or \`bricksRemaining\`, \`score\`, and authored \`scenarios\` with ids: \`paddleMove\`, \`launch\`, \`wallBounce\`, \`paddleBounce\`, \`brickHit\`, \`powerup:wide\`, \`powerup:multi\`, \`powerup:slow\`, \`powerup:through\`, \`powerup:life\`, \`win\`, \`lose\`.
- Breakout/Arkanoid scaffold: \`snapshot()\` returns \`{ paddleX, paddle, ball, balls, brickCount, bricksRemaining, score, wallBounceCount, paddleBounceCount, lives, status, activePowerups, powerupsTriggered }\`; \`reset(scenario)\` must support every authored scenario id above.
- Include \`qualityPlan\` or object-shaped \`acceptance\` for actorReadable, mechanics, rewards, risks, levelsCovered, allAuthoredLevelsReachable. Do not use \`acceptance: ['move', 'jump']\` as a checklist; string-array acceptance is quality prose, not an executable validation plan.
- Include literal \`progressPlan\` or \`reachability\`; for platformer/breakout every input must come from declared controls, never \`'none'\` or empty. For runner only, one designated auto-run distance probe may use \`input: ""\` or \`input: []\` when metadata has \`autoRun: true\`; every jump/slide/lane step still uses declared controls; generic \`progress\`, \`coverage\`, \`objectives\`, \`coreLoop\`, \`qualityPlan\`, or string-array \`acceptance\` does not satisfy this field.
- Each step uses metadata controls, a \`snapshot()\` metric path, and expect increase/decrease/change/truthy or literal target. Example:
  \`progressPlan: [{ label: 'move right', input: 'ArrowRight', frames: 24, metric: 'player.x', expect: 'increase' }, { label: 'jump arc', input: ['ArrowRight', 'Space'], frames: 20, metric: 'player.y', expect: 'change' }]\`
- For movement metrics like \`player.x\`, \`player.y\`, \`player.vx\`, \`player.vy\`, the expect MUST be one of "increase" / "decrease" / "change", never a numeric target. A numeric or boolean expect means exact final equality after the declared frames, only valid for counters like \`enemiesDefeated\` / \`blocksUsed\` / \`gatesUnlocked\` or boolean flags like \`abilities.doubleJump\`.
- Reachability steps must be short, deterministic, and locally true: use real snapshot paths such as \`player.x\`, \`player.vy\`, \`enemiesDefeated\`, \`blocksUsed\`, \`abilities.doubleJump\`, \`gatesUnlocked\`, \`routesUnlocked\`; do not expect score/progress/win/gate/ability changes unless that exact input window triggers live collision.
- For platformers, nearby authored smoke scenarios like \`reset('stomp')\`, \`reset('bumpBlock')\`, \`reset('gainAbility')\`, and \`reset('unlockGate')\` are better than long full-level treks, but they must still use live physics/collision.
- For Breakout/Arkanoid, \`reset(scenario)\` must place the ball, paddle, brick, or powerup into a deterministic live-game position. Examples: \`reset('wallBounce')\` starts the ball near a side wall, \`reset('paddleBounce')\` starts it above the paddle, \`reset('brickHit')\` starts it near a brick, and \`reset('powerup:life')\` starts with low lives so the life pickup can be observed.

Runtime required:
- Expose test contract methods: \`start()\`, \`reset(levelOrScenario?)\`, \`snapshot()\`, \`step(inputState, frames?)\`, \`runSmokeTest()\`.
- Assign exactly one direct plain object literal to \`window.__GAME_TEST__\` or \`window.__INTERACTIVE_TEST__\`, for example \`window.__GAME_TEST__ = { start() { ... }, reset(levelOrScenario) { ... }, snapshot() { return {...}; }, step(inputState = {}, frames = 1) { ...; return this.snapshot(); }, runSmokeTest() { return { passed, checks, failures, coverage }; } };\`.
- Do not hide the contract in comments, a class, a factory/IIFE wrapper, \`Object.assign\`, or separate orphan function blocks. Keep all five methods inside the one balanced object; avoid comments inside the active contract block and remove duplicate method tails after it closes.
- \`start()\` creates clean playable state; \`reset(levelOrScenario?)\` selects an authored unit and must support every declared id/key/name plus numeric index; \`snapshot()\` returns actor, progress, score/reward, status, level/scenario, and metadata metrics.
- \`step(inputState, frames?)\` drives real keyboard/pointer rules, accepts semantic controls plus real key codes, and must not auto-collect, auto-win, auto-open, auto-reach, or grant abilities.
- Real keyboard handlers must feed the same input keys consumed by \`step()\`. For Space, do not rely on \`event.key === 'Space'\`; normalize \`event.code === 'Space'\` or \`event.key === ' '\` to \`input.Space = true\` so the playable browser game and the test contract use the same launch/jump path.
- \`runSmokeTest()\` drives \`step()\`, compares before/after \`snapshot()\`, and returns \`{ passed, checks, failures, coverage }\` with string-array \`checks\`/\`failures\`. Fail on missing expected changes.
- Coverage must be input-driven and structured: levelsPassed, totalLevels, mechanics, rewards, risks, stateChanges, allLevelsReachable. Use named arrays/maps, not counts or object existence.
- For platformers, \`runSmokeTest()\` proves gameplayMechanics with before/after snapshots: stomp enemy defeated plus player bounce/vy, bump block used/spawnedReward, ability changes, gate/route reachability after ability, and comboChallenge sequence.
- For Breakout/Arkanoid, \`runSmokeTest()\` must prove: ArrowRight changes \`paddleX\`; launch changes \`ball.x\` or \`ball.y\`; \`wallBounceCount\` increases; \`paddleBounceCount\` increases; \`brickCount\` decreases or \`score\` increases; each of wide/multi/slow/through/life triggers an observable snapshot delta; win reaches won/complete; lose reaches lost/gameOver/lives=0.
- If authored levels/scenarios/segments exist, smoke coverage must reset and exercise every authored unit before claiming completion.
- Include browserVisualSmoke expectations when visual: desktop/wide-desktop/mobile viewport, canvasNonblank, primary game surface sized for the preview, rendered aspect ratio matches canvas internal resolution, actor/HUD visible, reward/risk/goal visible on first screen, no crop/overlap.
`.trim(),
);

export const GAME_ARTIFACT_REPAIR_CONTRACT_PROMPT = applyOverride(
  { id: 'artifact.gameRepairContract', category: '产物生成', name: '游戏修复契约', description: '修复 / 校验 已有游戏 artifact 时的最小补丁约定' },
  `
## Game Artifact Repair Contract

Patch only the generated HTML and the validator-relevant metadata/test contract.
- Keep the playfield visible in narrow browser windows and substantial in wide previews: add responsive canvas/wrapper CSS with max-width/max-height/aspect-ratio/height:auto instead of shipping a fixed 800px/900px canvas or max-height-only scaling that can be cropped. The full canvas and HUD must fit inside a 390px mobile viewport, and wide desktop previews should not show the game as a small centered postage stamp.
- Repair the visible product quality, not only the contract: first screen must show the playable scene with actor, controls/HUD, reward, risk, and goal. A canvas with only a tiny actor on an empty field is not acceptable.
- For stickman / 火柴人 games, make the actor visually readable: head, torso, arms, legs, pose/animation, strong contrast, and a meaningful size relative to the playfield.
- Metadata must expose \`window.__GAME_META__\` / \`window.__INTERACTIVE_META__\` with controls, validator-readable authored units (\`levels\`, \`segments\`, \`scenarios\`, \`stages\`, \`missions\`, or \`objectives\`), \`progressPlan\` or \`reachability\` steps, and \`qualityPlan\` or object-shaped \`acceptance\`.
- Use the exact field name \`progressPlan\` or \`reachability\`; do not rename it to \`progress\`, \`coverage\`, or \`qualityPlan\`.
- If authored units use string ids such as \`level1\`, \`mechanics-route\`, or \`stomp\`, repair \`reset(levelOrScenario)\` so it accepts those exact values and numeric indexes. Do not leave reset numeric-only while metadata exposes string ids.
- Do not use string-array \`acceptance\` as the reachability plan; keep executable steps in \`progressPlan\` or \`reachability\`.
- For platformer/breakout, do not use \`input: 'none'\`, empty string, or empty array in \`progressPlan\` / \`reachability\`; every step must be executable with declared controls. For runner, only the designated \`autoRun: true\` distance probe may use \`input: ""\` or \`input: []\`; jump/slide/lane steps still use declared controls.
- Every reachability metric must exist in \`snapshot()\` and change within the declared frames; do not assert \`score increase\` after generic movement/jump.
- For movement metrics (\`player.x\` / \`player.y\` / \`player.vx\` / \`player.vy\`), expect MUST be "increase" / "decrease" / "change", never numeric. Numeric expect = exact equality, only for counters and boolean flags.
- For platformers, add/repair \`gameplayMechanics\` with enemies, blocks, abilities, gates, and comboChallenge, wired to real \`step()\` gameplay and \`runSmokeTest()\` before/after snapshot evidence.
- Platformer \`gameplayMechanics.enemies\`, \`blocks\`, \`abilities\`, \`gates\`, and \`comboChallenge\` must be arrays; do not repair them as \`{ enemies: { ... } }\` or keyed object maps.
- If the full level path is too long, repair platformers with deterministic authored scenarios for stomp, bumpBlock, gainAbility, unlockGate, and comboChallenge using the live rules.
- For Breakout/Arkanoid, add/repair \`paddleX\`, \`ball\`, \`wallBounceCount\`, \`paddleBounceCount\`, \`brickCount\` or \`bricksRemaining\`, \`score\`, and deterministic \`reset()\` scenarios for paddleMove, launch, wallBounce, paddleBounce, brickHit, every powerup, win, and lose. These scenarios must use the same live \`step()\` state as the playable loop.
- Test contract must expose \`start()\`, \`reset(levelOrScenario?)\`, \`snapshot()\`, \`step(inputState, frames?)\`, and \`runSmokeTest()\`.
- Repair the test contract as exactly one direct object assignment: \`window.__GAME_TEST__ = { start() { ... }, reset(levelOrScenario) { ... }, snapshot() { return {...}; }, step(inputState = {}, frames = 1) { ...; return this.snapshot(); }, runSmokeTest() { return { passed, checks, failures, coverage }; } };\` or the same shape on \`window.__INTERACTIVE_TEST__\`.
- Do not put the contract inside comments, a wrapper function, a class, \`Object.assign\`, or separate top-level functions with a malformed tail. Keep all five methods inside one balanced object literal and delete duplicate/orphaned \`start/reset/snapshot/step/runSmokeTest\` blocks after it closes.
- \`step(inputState, frames?)\` must accept the semantic control names in metadata and the real key codes/aliases; repair mismatches such as metadata declaring \`ArrowRight\` while step only reads \`right\`.
- Browser keyboard listeners must normalize Space correctly: \`event.code === 'Space'\` or \`event.key === ' '\` must set the same \`Space\` state that \`step({ Space: true })\` uses. A handler that stores only \`keys[event.key]\` will break real Space launch.
- \`runSmokeTest()\` coverage must use \`mechanics\`, \`rewards\`, \`risks\`, \`stateChanges\`, \`levelsPassed\`, \`totalLevels\`, and \`allLevelsReachable\`; coverage fields must list evidence names or boolean evidence maps, never numeric counts.
- Platformer coverage must prove stompEnemy, bumpBlock, gainAbility, unlockGate/routeReachableAfterAbility, and comboChallenge, with stateChanges for enemiesDefeated, player.vy/bounce, blocksUsed/spawnedReward, abilities, and gates/routes.
- Breakout/Arkanoid coverage must prove paddleMove, launch, wallBounce, paddleBounce, brickHit, wide/multi/slow/through/life powerups, win, and lose, with stateChanges for paddleX, ball position, wallBounceCount, paddleBounceCount, brickCount/bricksRemaining, score, powerupsTriggered, lives, and status.
- \`runSmokeTest()\` must return \`checks\` and \`failures\` as string arrays, not numeric counts, and each assertion should fail only when the observed before/after state contradicts the expected result.
- Only record coverage after before/after \`snapshot()\` changes driven by \`step()\` or real controls. No direct score/progress/level/win/unlock grants, and no existence-only coverage.

## Reference implementation for runSmokeTest()

The rules above are abstract. Below is the minimum working pattern. EVERY
mechanic check MUST follow: reset → before snapshot → step() with real declared
controls → after snapshot → compare → push exactly one \`checks\` OR \`failures\`
entry. Do NOT push to coverage unless before/after differ. Adapt field names
to what your snapshot() actually exposes — the key is the pattern, not the
literal names.

\`\`\`js
runSmokeTest() {
  const checks = [];
  const failures = [];
  // Initialize ALL coverage fields up front — including levelsPassed/totalLevels/
  // allLevelsReachable — so the return statement is a simple { ...coverage }
  // reference. Never read or assign these names as top-level variables.
  const coverage = {
    mechanics: [],
    rewards: [],
    risks: [],
    stateChanges: [],
    levelsPassed: [],
    totalLevels: 1,
    allLevelsReachable: true,
  };

  // --- stomp enemy ---
  this.reset();
  const beforeStomp = this.snapshot();
  // Use the EXACT control names from __GAME_META__.controls (e.g. ArrowRight, Space).
  this.step({ ArrowRight: true, Space: true }, 30);
  const afterStomp = this.snapshot();
  if (afterStomp.enemiesDefeated > beforeStomp.enemiesDefeated && afterStomp.player.vy < 0) {
    checks.push('stomp_enemy');
    coverage.mechanics.push('stompEnemy');
    coverage.stateChanges.push('enemiesDefeated');
    coverage.stateChanges.push('player.vy');
  } else {
    failures.push('stomp_enemy: enemiesDefeated or player.vy did not change');
  }

  // --- bump block (same pattern) ---
  this.reset();
  const beforeBump = this.snapshot();
  this.step({ ArrowRight: true, Space: true }, 30);
  const afterBump = this.snapshot();
  if (afterBump.blocksUsed > beforeBump.blocksUsed) {
    checks.push('bump_block');
    coverage.mechanics.push('bumpBlock');
    coverage.stateChanges.push('blocksUsed');
  } else {
    failures.push('bump_block: blocksUsed did not increase');
  }

  // --- gain ability (e.g. doubleJump unlocked by bumping a question block) ---
  this.reset();
  const beforeAbility = this.snapshot();
  this.step({ ArrowRight: true, Space: true }, 60);
  const afterAbility = this.snapshot();
  if (!beforeAbility.player.abilities.doubleJump && afterAbility.player.abilities.doubleJump) {
    checks.push('gain_ability');
    coverage.mechanics.push('gainAbility');
    coverage.stateChanges.push('abilities.doubleJump');
  } else {
    failures.push('gain_ability: abilities.doubleJump did not flip false->true');
  }

  // --- unlock gate (only after ability) ---
  this.reset();
  this.step({ ArrowRight: true, Space: true }, 60);   // gain ability first
  this.step({ ArrowRight: true, Shift: true }, 80);   // use doubleJump to reach gate
  const afterGate = this.snapshot();
  if (afterGate.player.gatesUnlocked && afterGate.player.gatesUnlocked.length > 0) {
    checks.push('unlock_gate');
    coverage.mechanics.push('unlockGate');
    coverage.stateChanges.push('gatesUnlocked');
  } else {
    failures.push('unlock_gate: gatesUnlocked stayed empty after acquiring ability');
  }

  // --- combo challenge: jump + stomp + ability + gate ---
  this.reset();
  this.step({ ArrowRight: true, Space: true }, 30);
  this.step({ ArrowRight: true, Space: true }, 30);
  this.step({ ArrowRight: true, Shift: true }, 40);
  const afterCombo = this.snapshot();
  if (afterCombo.enemiesDefeated > 0
      && afterCombo.player.abilities.doubleJump
      && afterCombo.player.gatesUnlocked.length > 0) {
    checks.push('combo_challenge');
    coverage.mechanics.push('comboChallenge');
  } else {
    failures.push('combo_challenge: missing prerequisite evidence');
  }

  // Finalize the level-pass tally on the same coverage object. Do NOT
  // introduce a top-level levelsPassed variable — it must live on coverage.
  coverage.levelsPassed = failures.length === 0 ? ['level-1'] : [];
  return { passed: failures.length === 0, checks, failures, coverage };
}
\`\`\`

Non-negotiable invariants:
- \`step(inputState, frames)\` MUST drive the same physics/collision code as the playable game loop. Do NOT mock — mechanics must emerge from real \`step()\` calls that mutate the shared live state (player, enemies, blocks, gates).
- \`snapshot()\` MUST expose the fields you assert on: counters like \`enemiesDefeated\` / \`blocksUsed\`, ability flags under \`player.abilities\`, and \`player.gatesUnlocked\` as an array of unlocked gate ids.
- Never grant state directly inside \`runSmokeTest\` (no \`player.score += 100\`, no \`player.abilities.doubleJump = true\`). Validation rejects such grants.
- \`step()\` may be invoked multiple times per mechanic — once to set up state (gain ability, position the player) and again to trigger the asserted event.
`.trim(),
);

export function needsArtifactTaskBrief(message: string): boolean {
  if (!message) return false;
  if (/\b(create|generate|build|make|design|implement|write|develop)\b|生成|创建|制作|做个|做一个|写一个|实现一个|设计一个|搭一个|开发|开发一个/i.test(message)) {
    return true;
  }

  const hasRepairIntent = /\b(fix|repair|patch|correct|debug|validate|verify|restore|update)\b|修复|修正|改好|验证|校验|失败|不通过|报错/i.test(message);
  const hasArtifactTarget = /\b\w[\w.-]*\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)\b|\/[\w .@-]+\/[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)|\\[\w .@-]+\\[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)/i.test(message);

  return hasRepairIntent && hasArtifactTarget;
}

export function needsGameArtifactContract(message: string): boolean {
  if (!message) return false;
  return needsArtifactTaskBrief(message) && /游戏|game|platformer|runner|breakout|arkanoid|弹砖块|打砖块|tower[_\s-]?defense|puzzle|rpg|shooter|mario|超级玛丽|关卡|level|stage|scenario|mission/i.test(message);
}
