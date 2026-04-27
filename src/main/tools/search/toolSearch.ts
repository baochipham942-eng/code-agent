// ============================================================================
// tool_search - 工具搜索和延迟加载
// ============================================================================

import type { Tool, ToolExecutionResult, ToolContext } from '../types';
import { getToolSearchService } from '../../services/toolSearch/toolSearchService';
import { getMCPClient } from '../../mcp/mcpClient';
import { createLogger } from '../../services/infra/logger';
import {
  TOOL_SEARCH_DESCRIPTION,
  TOOL_SEARCH_INPUT_SCHEMA,
} from '../modules/search/toolSearch.schema';

const logger = createLogger('tool_search');

/**
 * tool_search 工具
 *
 * 用于搜索和加载延迟工具。支持以下模式：
 *
 * 1. 关键字搜索：`tool_search("pdf")` → 搜索 PDF 相关工具
 * 2. 直接选择：`tool_search("select:WebFetch")` → 直接加载 web_fetch
 * 3. 必须前缀：`tool_search("+mcp search")` → 只搜索 MCP 相关工具
 *
 * 可调用的搜索结果会自动加载；不可直接调用的结果只作为搜索线索返回。
 */
export const toolSearchTool: Tool = {
  name: 'ToolSearch',
  description: TOOL_SEARCH_DESCRIPTION,

  inputSchema: TOOL_SEARCH_INPUT_SCHEMA,

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
      let mcpDiscovery: Array<{ serverName: string; connected: boolean; toolCount: number; error?: string }> = [];
      try {
        mcpDiscovery = await getMCPClient().discoverLazyServersForSearch(query);
      } catch (discoveryError) {
        logger.warn('Lazy MCP discovery during tool search failed', {
          error: discoveryError instanceof Error ? discoveryError.message : String(discoveryError),
        });
      }

      const result = await service.searchTools(query, {
        maxResults,
        includeMCP: true,
      });

      // 格式化输出
      if (result.tools.length === 0) {
        const discoveryFailures = mcpDiscovery
          .filter((discovery) => !discovery.connected || discovery.error)
          .map((discovery) => `- ${discovery.serverName}: ${discovery.error || 'not connected'}`);
        const discoveryHint = discoveryFailures.length > 0
          ? `\n\nMCP 懒加载发现失败：\n${discoveryFailures.join('\n')}`
          : '';
        return {
          success: true,
          output: `未找到匹配 "${query}" 的工具。${discoveryHint}\n\n提示：\n- 尝试使用更通用的关键字\n- 使用 "select:工具名" 直接加载已知工具\n- 核心工具（bash, read_file 等）无需搜索`,
          metadata: {
            loadedTools: result.loadedTools,
            totalCount: result.totalCount,
            hasMore: result.hasMore,
            mcpDiscovery,
          },
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
        const availability = tool.loadable === false
          ? `不可直接调用：${tool.notCallableReason || 'no direct tool definition is available'}`
          : '已加载，可直接调用';
        lines.push(`• **${tool.name}**${sourceInfo}`);
        lines.push(`  ${tool.description}${tags}`);
        lines.push(`  ${availability}`);
        if (tool.canonicalInvocation) {
          lines.push(`  调用入口：${tool.canonicalInvocation}`);
        }
        lines.push('');
      }

      if (result.hasMore) {
        lines.push(`还有 ${result.totalCount - result.tools.length} 个匹配结果，使用更具体的关键字缩小范围。`);
      }

      lines.push('');
      if (result.loadedTools.length > 0) {
        lines.push('已加载的工具现在可以直接使用；不可直接调用的结果只作为搜索线索。');
      } else {
        lines.push('没有新工具被加载；不可直接调用的结果只作为搜索线索。');
      }

      logger.info(`Search "${query}" loaded tools: ${result.loadedTools.join(', ')}`);

      return {
        success: true,
        output: lines.join('\n'),
        metadata: {
          loadedTools: result.loadedTools,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
          mcpDiscovery,
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
