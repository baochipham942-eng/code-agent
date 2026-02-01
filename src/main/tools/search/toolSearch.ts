// ============================================================================
// tool_search - 工具搜索和延迟加载
// ============================================================================

import type { Tool, ToolExecutionResult, ToolContext } from '../toolRegistry';
import { getToolSearchService } from './toolSearchService';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('tool_search');

/**
 * tool_search 工具
 *
 * 用于搜索和加载延迟工具。支持以下模式：
 *
 * 1. 关键字搜索：`tool_search("pdf")` → 搜索 PDF 相关工具
 * 2. 直接选择：`tool_search("select:web_fetch")` → 直接加载 web_fetch
 * 3. 必须前缀：`tool_search("+mcp search")` → 只搜索 MCP 相关工具
 *
 * 搜索结果中的工具会自动加载，下次模型请求时可直接使用。
 */
export const toolSearchTool: Tool = {
  name: 'tool_search',
  description: `搜索或选择延迟加载的工具，使其可用于后续调用。

**查询模式：**

1. **关键字搜索** - 根据名称、描述、别名搜索工具：
   - "pdf" → 搜索 PDF 相关工具
   - "image generate" → 搜索图片生成工具
   - 返回最多 5 个匹配结果，按相关度排序

2. **直接选择** - 使用 \`select:\` 前缀直接加载指定工具：
   - "select:web_fetch" → 加载 web_fetch 工具
   - "select:mcp__github__search_repos" → 加载 MCP 工具

3. **必须前缀** - 使用 \`+\` 前缀强制匹配某关键字：
   - "+mcp search" → 只搜索 MCP 相关工具，按 "search" 排序
   - "+network api" → 只搜索网络相关工具

**注意：**
- 搜索结果中的工具会自动加载，无需再次调用 tool_search
- 直接选择模式只加载该工具，不返回其他结果
- 核心工具（bash, read_file 等）无需搜索，始终可用`,

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询。支持关键字、"select:工具名" 或 "+必须词 关键字"',
      },
      max_results: {
        type: 'number',
        description: '最大返回结果数（默认 5，最大 10）',
      },
    },
    required: ['query'],
  },

  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  // ToolSearch 特有属性
  isCore: true,  // 标记为核心工具，始终发送给模型
  tags: ['search'],
  source: 'builtin',

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const maxResults = Math.min(params.max_results as number || 5, 10);

    if (!query || typeof query !== 'string') {
      return {
        success: false,
        error: 'query 参数必须是非空字符串',
      };
    }

    try {
      const service = getToolSearchService();
      const generationId = context.generation?.id;

      const result = await service.searchTools(query, {
        maxResults,
        generationId,
        includeMCP: true,
      });

      // 格式化输出
      if (result.tools.length === 0) {
        return {
          success: true,
          output: `未找到匹配 "${query}" 的工具。\n\n提示：\n- 尝试使用更通用的关键字\n- 使用 "select:工具名" 直接加载已知工具\n- 核心工具（bash, read_file 等）无需搜索`,
        };
      }

      const lines: string[] = [
        `找到 ${result.totalCount} 个匹配工具，已加载 ${result.loadedTools.length} 个：`,
        '',
      ];

      for (const tool of result.tools) {
        const sourceInfo = tool.source === 'mcp' && tool.mcpServer
          ? ` [MCP: ${tool.mcpServer}]`
          : '';
        const tags = tool.tags.length > 0 ? ` (${tool.tags.join(', ')})` : '';
        lines.push(`• **${tool.name}**${sourceInfo}`);
        lines.push(`  ${tool.description}${tags}`);
        lines.push('');
      }

      if (result.hasMore) {
        lines.push(`还有 ${result.totalCount - result.tools.length} 个匹配结果，使用更具体的关键字缩小范围。`);
      }

      lines.push('');
      lines.push('这些工具现在可以直接使用。');

      logger.info(`Search "${query}" loaded tools: ${result.loadedTools.join(', ')}`);

      return {
        success: true,
        output: lines.join('\n'),
        metadata: {
          loadedTools: result.loadedTools,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
        },
      };
    } catch (error) {
      logger.error('Tool search failed', error);
      return {
        success: false,
        error: `工具搜索失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
