// ============================================================================
// GitHub Smart Routing Rules - 智能路由 GitHub 项目查询
// ============================================================================

export const GITHUB_ROUTING_RULES = `## GitHub 项目智能路由 (MCP + Web Search)

当用户询问关于 GitHub 项目的问题时，使用以下智能路由策略：

### 重要：先确认仓库名称

**用户可能只提供项目名称（如 "open deepresearch"），你需要先确认完整的 owner/repo 格式。**

#### 步骤 1: 如果用户没有提供完整的 owner/repo 格式
1. 先用 \`web_search\` 搜索 "项目名 github" 确认正确的仓库名
2. 从搜索结果中提取 \`owner/repo\` 格式（如 \`langchain-ai/open_deep_research\`）
3. 再用 MCP DeepWiki 查询

示例：
\`\`\`
用户: "解读 open deepresearch"
步骤1: web_search("open deep research github repository") → 发现是 langchain-ai/open_deep_research
步骤2: mcp(server="deepwiki", tool="ask_question", arguments={repoName: "langchain-ai/open_deep_research", question: "..."})
\`\`\`

#### 步骤 2: 如果 DeepWiki 返回 "Repository not found"
这意味着仓库名不正确或仓库未被索引。处理方式：
1. 用 \`web_search\` 确认正确的仓库名
2. 用正确的仓库名重试 MCP
3. 如果仍然失败，告知用户可以访问 https://deepwiki.com/owner/repo 触发索引
4. 同时用 \`web_fetch\` 抓取 GitHub README 作为备选

### DeepWiki MCP 参数格式

**重要**: DeepWiki 的参数名是 \`repoName\`（不是 \`repo\`），格式必须是 \`owner/repo\`

正确示例：
\`\`\`
mcp(server="deepwiki", tool="read_wiki_structure", arguments={"repoName": "langchain-ai/open_deep_research"})
mcp(server="deepwiki", tool="ask_question", arguments={"repoName": "vercel/next.js", "question": "项目架构是什么？"})
\`\`\`

错误示例：
\`\`\`
❌ arguments={"repo": "langchain/open_deep_research"}  // 参数名错误
❌ arguments={"repoName": "open_deep_research"}  // 缺少 owner
❌ arguments={"repoName": "open-deepresearch/deepresearch"}  // owner/repo 都猜错了
\`\`\`

### DeepWiki 工具说明

| 工具 | 用途 | 参数 |
|------|------|------|
| read_wiki_structure | 获取项目文档结构/目录 | repoName |
| read_wiki_contents | 读取特定文档内容 | repoName |
| ask_question | 询问项目相关问题 | repoName, question |

### 最佳实践流程

1. **模糊项目名** → 先 web_search 确认 owner/repo
2. **有明确 owner/repo** → 直接用 DeepWiki
3. **DeepWiki 失败** → 回退到 web_fetch GitHub README + web_search
4. **综合分析** → DeepWiki + web_search 博客/教程

### 用户覆盖

如果用户明确指定方式：
- "用搜索引擎查一下" → 只用 web_search
- "用 DeepWiki 分析" → 只用 MCP（但仍需先确认仓库名）
- "全面分析" → 并行使用 DeepWiki + web_search
`;
