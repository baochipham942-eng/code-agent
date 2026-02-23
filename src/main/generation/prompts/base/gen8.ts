// ============================================================================
// Generation 8 - Claude Code Style (Compact) + Orchestrator Mode
// ============================================================================
// 目标：~600 tokens
// ============================================================================

export const GEN8_TOOLS = `
## Tools

| Tool | Use |
|------|-----|
| read_file | Read files |
| write_file | Create files |
| edit_file | Modify files (read first!) |
| bash | Shell commands (git/npm/test) |
| glob | Find files (patterns) |
| grep | Search content (regex) |
| task | Sub-agents (complex tasks) |
| teammate | Agent communication |
| todo_write | Track steps (multi-file tasks) |
| skill | Execute skills (/ppt, /commit, etc) |
| code_execute | Batch tool calls in JS (3+ similar ops) |

### code_execute (Programmatic Tool Calling)

When a task needs 3+ similar tool calls, use code_execute to batch them:
\`\`\`javascript
const files = await callTool('glob', { pattern: 'src/**/*.ts' });
let total = 0;
for (const f of files.output.split('\\n').filter(Boolean)) {
  const r = await callTool('read_file', { file_path: f });
  if (r.success) total += r.output.split('\\n').length;
}
return \`\${total} lines in \${files.output.split('\\n').filter(Boolean).length} files\`;
\`\`\`
Advantage: intermediate callTool results stay in code memory, only return/console.log enters your context.

### Slash Commands (Skills)

When user types \`/xxx\` (e.g., \`/ppt\`, \`/commit\`), call skill tool:
\`\`\`json
skill({ "command": "ppt", "args": "Code Agent 介绍，5页" })
\`\`\`

When user types a slash command, always route through the skill tool — direct tool calls bypass skill validation and dependency checks.

### Tool Rules

Use dedicated tools for file ops (no cat/grep/sed in bash) — dedicated tools provide structured output and are auditable.
Use \`teammate\` tool for agent coordination (coordinate/handoff/query/broadcast/inbox/agents).

### Multi-step Tasks

For 2+ files or 3+ steps, use todo_write FIRST:
\`\`\`json
{"todos": [
  {"id":"1","content":"Read code","status":"in_progress"},
  {"id":"2","content":"Implement","status":"pending"},
  {"id":"3","content":"Test","status":"pending"}
]}
\`\`\`
`;

// Orchestrator Mode prompt (for swarm scenarios)
export { getOrchestratorPrompt, getOrchestratorPromptCompact } from './orchestrator';

