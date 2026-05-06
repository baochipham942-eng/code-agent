// ============================================================================
// Artifact Generation Prompt - semantic brief + validation contract
// ============================================================================

export const ARTIFACT_TASK_BRIEF_PROMPT = `
## Artifact Task Brief

When the user asks you to create, generate, build, write, design, or implement an artifact, first infer a compact task brief before choosing tools. Use the brief privately unless showing it helps the user.

Brief fields:
- artifactKind: document | image | presentation | data_workbook | interactive_app | code_project | other
- domain: the real domain of the artifact, such as game, dashboard, editor, report, automation, visualization
- subtype: a useful subtype when the domain has one, such as platformer, runner, tower_defense, puzzle, form, landing_page
- coreLoop: for games or interactive apps, the repeated action cycle the user should actually experience
- requiredMechanics: concrete mechanics implied by the user's reference, not just visual theme
- validationPlan: what must be checked before claiming the artifact works

For large generated artifacts:
- Do not put a very large complete HTML/CSS/JS/document artifact into one Write call. If the complete single-file artifact is already available and medium-sized, one Write call is acceptable.
- If the target file path is explicit, start creating that file in the first tool-writing turn. The file tools create parent directories automatically, so do not spend a separate turn only making directories.
- Use chunked assembly: Write the initial skeleton or first chunk, then Append ordered chunks, and set \`final: true\` only on the last Append.
- If the last Append closes the document or otherwise makes the artifact runnable/complete, that same Append must include \`final: true\`. Do not leave a complete deliverable behind with \`final\` omitted.
- Keep each Write/Append content argument reasonably small and coherent: metadata/bootstrap, markup, styles, data, mechanics, validation helpers, closing tags.
- After the final chunk, verify the created file with Read, Bash, or browser/computer tools as appropriate before final response.

For games:
- Treat references to an existing genre or game as mechanics to translate, not just skins. Infer the relevant mechanics from the user's request instead of relying on a fixed keyword list.
- If there are authored levels, stages, scenarios, or missions, every one must be beatable/recoverable under the artifact's own rules. If content is procedural, every generated segment must preserve local solvability and fair reaction windows.
- Named or implied upgrades, power-ups, inventory, enemies, hazards, scoring, health, checkpoints, win states, fail states, objectives, and progression must change real runtime state.
- Make the first playable screen prove the fantasy immediately: the primary actor must be recognizable, the player must have a real control loop, and at least one reward/upgrade plus one risk/constraint must already exist on screen when the request implies them. Do not ship placeholder boxes or "logic only" demos for character or genre game requests.
- Use metadata to describe the promises you are making. Include a \`qualityPlan\` or \`acceptance\` object with fields such as \`actorReadable\`, \`mechanics\`, \`rewards\`, \`risks\`, \`levelsCovered\`, and \`allAuthoredLevelsReachable\`. Keep it generic to the built game instead of hardcoding a genre vocabulary.
- Expose validation metadata in the artifact as \`window.__GAME_META__\`, \`window.__INTERACTIVE_META__\`, or a JSON script block. Include domain, subtype, controls, core loop, objectives/scenarios/levels/segments, player or primary actor capabilities, win/fail conditions, feedback states, and reachability/progress assumptions.
- Include a generic reachability/progress plan in metadata, using fields like \`reachability\`, \`acceptance\`, \`smokePlan\`, or \`progressPlan\`. Each step must use executable inputs and exact state fields, such as \`{ input: "ArrowRight", metric: "progress", expect: "increase" }\` or \`{ input: ["ArrowRight", "Space"], metric: "state", expect: "gameWon" }\`.
- In reachability/progress metadata:
  - \`input\`, \`key\`, \`control\`, or \`code\` must be real controls that can be dispatched from the browser, using the same key values exposed in \`controls\`. Good: \`ArrowRight\`, \`Space\`, \`["ArrowRight","Space"]\`. Bad: \`"reach flag"\`, \`"collect mushroom"\`, \`"move+collect"\`.
  - \`metric\` must be an exact \`snapshot()\` field or path, such as \`playerX\`, \`powerUp\`, \`state\`, \`score\`, or \`progress\`. Do not invent metric names that are absent from \`snapshot()\`.
  - \`expect\` should be one of \`increase\`, \`decrease\`, \`change\`, \`truthy\`, or an exact literal target value like \`"gameWon"\`, \`"doublejump"\`, \`true\`, or \`3\`.
- Expose a small runtime test contract as \`window.__INTERACTIVE_TEST__\` or \`window.__GAME_TEST__\`:
  - \`start()\`: starts the artifact from a clean initial state.
  - \`reset(levelOrScenario?)\`: for authored levels, stages, scenarios, or missions, resets deterministically to the requested authored unit by id/name/index so validation can prove each one is reachable.
  - \`step(inputState, frames?)\`: advances the same game state used by real input handlers. Prefer this for deterministic headless tests and keep it consistent with keyboard/pointer controls.
  - \`snapshot()\`: returns structured state for the primary actor/object, progress, score/reward, status, and visible feedback.
  - \`runSmokeTest()\`: programmatically performs the core interaction for a few seconds and returns \`{ passed, checks, failures, coverage }\`. It must prove that user input changes state, produces visible/meaningful feedback, exercises requested mechanics/rewards/risks when present, and can make progress toward objectives.
- The test contract must not cheat on behalf of the player. \`step()\` may advance deterministic physics/input, but it must not auto-collect rewards from generous distances, auto-reach goals, auto-open doors, auto-win, or grant abilities outside the same collision and progression rules used by real play. \`runSmokeTest()\` must not count existence, registration, or metadata as proof of rewards/risks/mechanics; it should compare before/after \`snapshot()\` state caused by simulated player inputs.
- If the artifact has a real-time loop, make \`runSmokeTest()\` deterministic in headless mode. Prefer driving \`step(inputState, frames)\` directly, or pause the main loop during the test. Do not rely only on unresolved \`requestAnimationFrame\` waits.
- Make \`runSmokeTest().checks\` and \`failures\` plain strings, not rich objects.
- The \`coverage\` payload should be structured enough for the runtime to inspect. Prefer generic fields like \`levelsPassed\`, \`totalLevels\`, \`mechanics\`, \`rewards\`, \`risks\`, \`stateChanges\`, and \`allLevelsReachable\`. If the game has authored multi-level content, \`levelsPassed\` must cover every authored level before you claim the artifact is complete, and \`reset(levelOrScenario?)\` must let validation drive those authored units directly.
- Validate launch, controls, visible state changes, requested mechanics, win/fail paths, and reachability for all authored levels/scenarios/segments before final response. Do not claim a game works just because event listeners, a render loop, or metadata exist.
`.trim();

export function needsArtifactTaskBrief(message: string): boolean {
  if (!message) return false;
  if (/\b(create|generate|build|make|design|implement|write)\b|生成|创建|制作|做个|做一个|写一个|实现一个|设计一个|搭一个/i.test(message)) {
    return true;
  }

  const hasRepairIntent = /\b(fix|repair|patch|correct|debug|validate|verify|restore|update)\b|修复|修正|改好|验证|校验|失败|不通过|报错/i.test(message);
  const hasArtifactTarget = /\b\w[\w.-]*\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)\b|\/[\w .@-]+\/[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)|\\[\w .@-]+\\[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)/i.test(message);

  return hasRepairIntent && hasArtifactTarget;
}
