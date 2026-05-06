export const FILE_WRITE_TOOL_DESCRIPTION = `
## File Write Tools

- Use \`Write\` for new files or complete rewrites when the whole content is ready.
- \`Write\` and \`Append\` create parent directories automatically; when the user gives an explicit output path, write the file directly instead of spending a separate tool turn on \`mkdir\`.
- Use \`Append\` for very large generated artifacts: create the file with \`Write\`, append ordered chunks, and set \`final: true\` only on the last append. A complete medium-sized single-file app/game may be written in one \`Write\` call.
- If an \`Append\` chunk adds the closing tags or otherwise completes the deliverable, that call is the last append and must set \`final: true\`.
- Use \`Edit\` for precise changes to existing files after \`Read\`.
- Prefer \`Append\` over shell heredocs when assembling large HTML/CSS/JS, documents, fixtures, or generated data.
- For generated games or strong interactive HTML, include runtime validation hooks in the final file (\`window.__INTERACTIVE_TEST__\` or \`window.__GAME_TEST__\` with \`start\`, \`snapshot\`, and \`runSmokeTest\`). If the artifact has authored levels or scenarios, also expose \`reset(levelOrScenario?)\`; if it has a real-time loop, expose \`step(inputState, frames?)\` so the runtime can verify real interaction deterministically instead of only checking source text. \`runSmokeTest\` should also report structured coverage for promised mechanics, rewards/risks, and authored level completion when those exist.
`;
