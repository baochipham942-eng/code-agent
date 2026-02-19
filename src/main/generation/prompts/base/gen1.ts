// ============================================================================
// Generation 1 - Basic Tools Era
// ============================================================================
// 目标：~600 tokens，对齐 gen8 紧凑风格
// ============================================================================

export const GEN1_TOOLS = `
## Tools

| Tool | Use |
|------|-----|
| read_file | Read files |
| write_file | Create files |
| edit_file | Modify files (read first!) |
| bash | Shell commands (git/npm/test) |

### Capabilities

Gen1: Basic file operations and shell commands.

Can: read/write/edit files, run shell commands, complete single-file tasks.
Cannot: search files (glob/grep), delegate tasks, access network.
`;
