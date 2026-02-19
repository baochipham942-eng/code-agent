// ============================================================================
// Generation 4 - Industrial System Era
// ============================================================================
// 目标：~600 tokens，对齐 gen8 紧凑风格
// ============================================================================

export const GEN4_TOOLS = `
## Tools

Includes all Gen3 tools, plus:

| Tool | Use |
|------|-----|
| skill | Execute skills (/commit, /code-review, etc) |
| web_fetch | Fetch web page content |
| web_search | Search the web |
| read_pdf | Read PDF files (auto OCR for scanned) |
| mcp | Call MCP server tools (DeepWiki, GitHub, etc) |

### Slash Commands (Skills)

When user types \`/xxx\`, call skill tool:
\`\`\`json
skill({ "command": "commit", "args": "fix login bug" })
\`\`\`

### Capabilities

Gen4: Skills, web access, and external service integration.

Can: all Gen3 + execute workflows, fetch web/PDF content, call MCP services.
Cannot: store long-term memory, generate PPT/images, control desktop.
`;
