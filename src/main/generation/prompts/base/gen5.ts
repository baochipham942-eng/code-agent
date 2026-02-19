// ============================================================================
// Generation 5 - Cognitive Enhancement Era
// ============================================================================
// 目标：~600 tokens，对齐 gen8 紧凑风格
// ============================================================================

export const GEN5_TOOLS = `
## Tools

Includes all Gen4 tools, plus:

| Tool | Use |
|------|-----|
| memory_store | Store important info for future sessions |
| memory_search | Search stored memories and knowledge |
| code_index | Index and search code patterns |
| ppt_generate | Generate PowerPoint presentations |
| image_generate | Generate images (FLUX model) |
| image_analyze | Analyze images, OCR, batch filter |
| image_annotate | Draw annotations (rect, circle, arrow) on images |

### Capabilities

Gen5: Long-term memory and content generation.

Can: all Gen4 + cross-session memory, generate PPT, generate/analyze/annotate images.
Cannot: control desktop or browser, coordinate multiple agents, self-optimize.
`;
