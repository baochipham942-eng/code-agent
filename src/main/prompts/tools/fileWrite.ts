export const FILE_WRITE_TOOL_DESCRIPTION = `
## File Write Tools

- Use \`Write\` for new files or complete rewrites when the whole content is ready.
- \`Write\` and \`Append\` create parent directories automatically; when the user gives an explicit output path, write the file directly instead of spending a separate tool turn on \`mkdir\`.
- Use \`Append\` for very large generated artifacts: create the file with \`Write\`, append ordered chunks, and set \`final: true\` only on the last append. A complete medium-sized single-file app/game may be written in one \`Write\` call.
- If an \`Append\` chunk adds the closing tags or otherwise completes the deliverable, that call is the last append and must set \`final: true\`.
- Use \`Edit\` for precise changes to existing files after \`Read\`.
- Prefer \`Append\` over shell heredocs when assembling large HTML/CSS/JS, documents, fixtures, or generated data.
- For generated games or strong interactive HTML, the final file must include \`window.__GAME_META__\` / \`window.__INTERACTIVE_META__\` coverage metadata and \`window.__GAME_TEST__\` / \`window.__INTERACTIVE_TEST__\` with all five methods: \`start()\`, \`reset(levelOrScenario?)\`, \`snapshot()\`, \`step(inputState, frames?)\`, and \`runSmokeTest()\`. Metadata must include exact \`progressPlan\` or \`reachability\` steps with dispatchable inputs and snapshot metrics; do not use \`input: 'none'\`, and a generic \`progress\` or \`coverage\` object is not enough. \`step()\` must accept declared semantic controls and real key codes. \`runSmokeTest()\` must report input-driven structured coverage for promised mechanics, rewards, risks, progress, and every authored level/scenario/segment when present, with \`checks\` and \`failures\` returned as string arrays; coverage fields must name evidence or use boolean maps, not numeric counts.
- For platformer games, metadata must also include \`gameplayMechanics\` with enemies, blocks, abilities, gates, and comboChallenge. The runtime test must prove stomp enemy, bump block, gain ability, unlock gate/route, and comboChallenge through before/after \`snapshot()\` changes or explicit input-driven coverage.
- Large canvas games must include responsive canvas or wrapper CSS (\`max-width\`, \`max-height\`, \`aspect-ratio\`, \`height:auto\`, or equivalent) so the whole playfield fits the browser viewport.
- Browser games should be authored to pass visual smoke in both desktop and narrow/mobile viewports: nonblank canvas or visible DOM gameplay, actor visible, HUD framed, no horizontal canvas crop, and no obvious critical UI overlap.
`;
