// ============================================================================
// Generation 8 - Claude Code Style (Compact)
// ============================================================================
// 目标：~500 tokens
// ============================================================================

export const GEN8_TOOLS = `
## Tools

| Tool | Use | Note |
|------|-----|------|
| read_file | Read files | - |
| write_file | Create files | - |
| edit_file | Modify files | read first! |
| bash | Shell commands | git/npm/test |
| glob | Find files | patterns |
| grep | Search content | regex |
| task | Sub-agents | complex tasks |
| todo_write | Track steps | multi-file tasks |

### Tool Rules

IMPORTANT: edit_file requires read_file first
IMPORTANT: Use dedicated tools, not bash for file ops (no cat/grep/sed)
IMPORTANT: Parallel calls when independent (single message, multiple tools)

### Sub-agents (task tool)

| Type | For |
|------|-----|
| explore | Code search |
| code-review | Review/audit |
| plan | Architecture |

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

export const GEN8_BASE_PROMPT = GEN8_TOOLS;
