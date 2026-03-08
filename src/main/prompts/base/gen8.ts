// ============================================================================
// Generation 8 - Claude Code Style (Compact) + Orchestrator Mode
// ============================================================================
// 目标：~600 tokens
// ============================================================================

export const TOOLS_PROMPT = `
## Tools

| Tool | Use |
|------|-----|
| Read | Read files |
| Write | Create files |
| Edit | Modify files (read first!) |
| Bash | Shell commands (git/npm/test) |
| Glob | Find files (patterns) |
| Grep | Search content (regex) |
| WebSearch | Search the web |
| AskUserQuestion | Ask user for clarification |
| task | Sub-agents (complex tasks) |
| teammate | Agent communication |
| TodoWrite | Track steps (multi-file tasks) |
| Skill | Execute skills (/ppt, /commit, etc) |
| CodeExecute | Batch tool calls in JS (3+ similar ops) |

### CodeExecute (Programmatic Tool Calling)

When a task needs 3+ similar tool calls, use CodeExecute to batch them:
\`\`\`javascript
const files = await callTool('Glob', { pattern: 'src/**/*.ts' });
let total = 0;
for (const f of files.output.split('\\n').filter(Boolean)) {
  const r = await callTool('Read', { file_path: f });
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

Use dedicated tools for file ops (no cat/grep/sed in Bash) — dedicated tools provide structured output and are auditable.
Use \`teammate\` tool for agent coordination (coordinate/handoff/query/broadcast/inbox/agents).

### Multi-step Tasks

For 2+ files or 3+ steps, use TodoWrite FIRST:
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

