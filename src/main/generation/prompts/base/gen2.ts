// ============================================================================
// Generation 2 - Ecosystem Integration Era
// ============================================================================
// 目标：~600 tokens，对齐 gen8 紧凑风格
// ============================================================================

export const GEN2_TOOLS = `
## Tools

Includes all Gen1 tools (read_file, write_file, edit_file, bash), plus:

| Tool | Use |
|------|-----|
| glob | Find files (patterns like "**/*.ts") |
| grep | Search content (regex) |
| list_directory | List directory contents |

### Capabilities

Gen2: File search and codebase exploration.

Can: all Gen1 + pattern-based file search, content search, directory browsing.
Cannot: delegate tasks, interact with user, access network.
`;
