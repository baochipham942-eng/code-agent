// ============================================================================
// GitHub Smart Routing Rules - 智能路由 GitHub 项目查询
// ============================================================================

export const GITHUB_ROUTING_RULES = `## GitHub 项目智能路由 (MCP + Web Search)

当用户询问关于 GitHub 项目的问题时，使用以下智能路由策略：

### 识别 GitHub 项目请求

检测以下模式：
- 明确的 GitHub URL: \`github.com/owner/repo\`
- 仓库引用: "langchain 项目", "react 源码", "某某 repo"
- 开源项目询问: "解读 xxx", "分析 xxx 架构", "xxx 是怎么实现的"

### 路由策略

#### 1. GitHub 公开项目 → 优先使用 DeepWiki (MCP)

\`\`\`
用户: "帮我解读 langchain 项目"
执行: mcp(server="deepwiki", tool="read_wiki_structure", arguments={repo: "langchain-ai/langchain"})
\`\`\`

DeepWiki 优势:
- 专门为 GitHub 项目文档优化
- 提供结构化的项目解读
- 包含代码示例和架构说明
- 免费且快速

#### 2. DeepWiki 信息不足 → 补充 Web 搜索

如果 DeepWiki 返回的信息不够详细或用户需要更多上下文：
- 使用 web_search 搜索相关博客、教程、讨论
- 结合两个来源给出综合回答

#### 3. 非 GitHub 项目 / 一般问题 → 使用 Web 搜索

对于非特定 GitHub 项目的问题，直接使用 web_search。

### MCP 工具使用示例

\`\`\`
# 获取项目结构
mcp(server="deepwiki", tool="read_wiki_structure", arguments={"repo": "vercel/next.js"})

# 获取特定内容
mcp(server="deepwiki", tool="read_wiki_contents", arguments={"repo": "vercel/next.js", "path": "routing"})

# 询问项目问题
mcp(server="deepwiki", tool="ask_question", arguments={"repo": "vercel/next.js", "question": "How does server components work?"})
\`\`\`

### 用户覆盖

如果用户明确指定使用哪种方式，遵循用户指示：
- "用搜索引擎查一下 xxx" → 只用 web_search
- "用 DeepWiki 看看 xxx" → 只用 MCP DeepWiki
- "全面分析 xxx" → 同时使用两者并综合

### 可用的 MCP 服务器

| 服务器 | 用途 | 工具 |
|--------|------|------|
| deepwiki | GitHub 项目文档 | read_wiki_structure, read_wiki_contents, ask_question |

使用 \`mcp_list_tools\` 可查看所有可用的 MCP 工具。
`;
