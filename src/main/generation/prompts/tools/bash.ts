// ============================================================================
// Bash Tool Description - Claude Code Style (Compact)
// ============================================================================
// 目标：~500 tokens（包含 Git 核心工作流）
// ============================================================================

export const BASH_TOOL_DESCRIPTION = `
## Bash Tool

Run shell commands (git, npm, build, test). Timeout: 120s default, 600s max.

### Rules
- Quote paths with spaces: \`cd "/path/with spaces"\`
- Verify parent dir before creating files
- Use && for dependent commands: \`git add . && git commit -m "msg"\`
- Parallel calls for independent ops

### Forbidden (use dedicated tools)
| Don't | Use |
|-------|-----|
| cat/head/tail | read_file |
| find | glob |
| grep -r | grep |
| sed | edit_file |
| echo > | write_file |

## Git Commit

When user asks to commit:

1. **Gather** (parallel, one message):
   \`git status\` + \`git diff\` + \`git log -3 --oneline\`

2. **Analyze** in tags:
   \`\`\`
   <commit_analysis>
   Files: ..., Type: feature/fix/refactor, Message: ...
   </commit_analysis>
   \`\`\`

3. **Commit**:
   \`\`\`bash
   git add <files>
   git commit -m "type: description"
   \`\`\`

4. **Verify**: \`git status\`

### Git Safety
IMPORTANT: No --force unless user asks
IMPORTANT: No --no-verify unless user asks
IMPORTANT: No push unless user asks
IMPORTANT: Add specific files, not \`git add .\`
`;
