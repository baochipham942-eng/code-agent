// ============================================================================
// ToolSearch (P1 Wave 1 — search: native ToolModule rewrite)
//
// 旧版: src/host/tools/search/toolSearch.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger（不再 import services/infra/logger）
// - 错误码规范化：INVALID_ARGS / PERMISSION_DENIED / ABORTED / SEARCH_ERROR
// - 行为保真：legacy 输出格式（中文文案、bullet、提示行）1:1 复刻
// - self-reference 安全：直接调 getToolSearchService() 和 getMCPClient() 单例，
//   不通过 modules/index.ts 反向解析其他 tool。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getToolSearchService } from '../../../services/toolSearch/toolSearchService';
import { getMCPClient } from '../../../mcp/mcpClient';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { normalizeWorkbenchToolScope, isToolNameAllowedByWorkbenchScope } from '../../workbenchToolScope';
import { toolSearchSchema as schema } from './toolSearch.schema';
import { getCapabilityRecommender } from '../../../services/capability';
import { renderGaps } from '../planning/recommendCapability';
import { markDistilledSkillTurnSignal } from '../../../services/skills/distillSignalStore';

const MAX_RESULTS_HARD_CAP = 10;
const DEFAULT_MAX_RESULTS = 5;

interface McpDiscoveryEntry {
  serverName: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export async function executeToolSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // query 的“必填 + 非空白字符串”由 inputSchema 保证（minLength + pattern），
  // executor/resolver 两层 schema 门拦坏输入，此处不再手写重复校验。
  const query = args.query as string;

  const rawMax = args.max_results;
  const maxResults = Math.min(
    typeof rawMax === 'number' && rawMax > 0 ? rawMax : DEFAULT_MAX_RESULTS,
    MAX_RESULTS_HARD_CAP,
  );

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  try {
    const service = getToolSearchService();
    let mcpDiscovery: McpDiscoveryEntry[] = [];
    try {
      mcpDiscovery = await getMCPClient().discoverLazyServersForSearch(query);
    } catch (discoveryError) {
      ctx.logger.warn('Lazy MCP discovery during tool search failed', {
        error: discoveryError instanceof Error ? discoveryError.message : String(discoveryError),
      });
    }

    const result = await service.searchTools(query, {
      maxResults,
      includeMCP: true,
      ...(ctx.deniedToolNames?.length ? { deniedToolNames: ctx.deniedToolNames } : {}),
    });

    // 与 mcpUnified 同一份口径：本轮 MCP 收窄生效时，不把范围外 server 的工具搜出来——
    // 搜出来模型照单点名、调用在 dispatch 门挨挡，「看见却调不动」比看不见更误导。
    // 计数也要对齐过滤后的列表，否则「找到 N 个」与列出的条目对不上；
    // hasMore 保留服务真值——范围内匹配超过 maxResults 时模型该知道还能缩关键词
    const scopedMcpServerIds = normalizeWorkbenchToolScope(ctx.toolScope)?.allowedMcpServerIds;
    if (scopedMcpServerIds?.length) {
      result.tools = result.tools.filter((tool) =>
        tool.source !== 'mcp' || !tool.mcpServer || scopedMcpServerIds.includes(tool.mcpServer));
      result.loadedTools = result.loadedTools.filter((name) =>
        isToolNameAllowedByWorkbenchScope(name, ctx.toolScope));
      result.totalCount = result.tools.length;
      mcpDiscovery = mcpDiscovery.filter((entry) => scopedMcpServerIds.includes(entry.serverName));
    }

    // ToolSearch 返回的蒸馏 skill 是本轮真实进入候选集的技能。先记 selected，
    // turn 收尾时若没有后续 Skill 激活就形成 skipped -1；若激活则同 turn 覆盖为 adopted +1。
    if (ctx.turnId) {
      for (const item of result.tools) {
        if (!item.name.startsWith('skill:')) continue;
        markDistilledSkillTurnSignal({
          turnId: ctx.turnId,
          skillName: item.name.slice('skill:'.length),
          sessionId: ctx.sessionId,
          kind: 'selected',
        });
      }
    }

    onProgress?.({ stage: 'completing', percent: 100 });

    if (result.tools.length === 0) {
      const discoveryFailures = mcpDiscovery
        .filter((discovery) => !discovery.connected || discovery.error)
        .map((discovery) => `- ${discovery.serverName}: ${discovery.error || 'not connected'}`);
      const discoveryHint = discoveryFailures.length > 0
        ? `\n\nMCP 懒加载发现失败：\n${discoveryFailures.join('\n')}`
        : '';
      const capabilityHint = (() => {
        if (!/^[a-z][a-z0-9-]*$/.test(query)) return '';
        const gaps = getCapabilityRecommender().scanForCapability(query);
        if (gaps.length === 0) return '';
        return `\n\n${renderGaps(query, gaps)}`;
      })();
      const output = `未找到匹配 "${query}" 的工具。${discoveryHint}${capabilityHint}\n\n提示：\n- 尝试使用更通用的关键字\n- 使用 "select:工具名" 直接加载已知工具\n- 核心工具（bash, read_file 等）无需搜索`;
      return {
        ok: true,
        output,
        meta: {
          query,
          maxResults,
          results: [],
          loadedTools: result.loadedTools,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
          mcpDiscovery,
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'search',
            sessionId: ctx.sessionId,
            name: `tool-search-${query}`,
            mimeType: 'text/markdown',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: {
              query,
              maxResults,
              totalCount: result.totalCount,
              loadedCount: result.loadedTools.length,
              resultCount: 0,
              mcpDiscoveryCount: mcpDiscovery.length,
            },
          }),
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
      const remaining = result.totalCount - result.tools.length;
      // scope 过滤后 totalCount 与列出数对齐（remaining 为 0），但服务说还有更多——
      // 范围内也可能有，给个不带假计数的提示
      lines.push(remaining > 0
        ? `还有 ${remaining} 个匹配结果，使用更具体的关键词缩小范围。`
        : '范围内可能还有更多匹配结果，使用更具体的关键词缩小范围。');
    }

    lines.push('');
    if (result.loadedTools.length > 0) {
      lines.push('已加载的工具现在可以直接使用；不可直接调用的结果只作为搜索线索。');
    } else {
      lines.push('没有新工具被加载；不可直接调用的结果只作为搜索线索。');
    }

    ctx.logger.info('ToolSearch done', {
      query,
      loaded: result.loadedTools.length,
      total: result.totalCount,
    });

    const output = lines.join('\n');
    return {
      ok: true,
      output,
      meta: {
        query,
        maxResults,
        results: result.tools,
        loadedTools: result.loadedTools,
        totalCount: result.totalCount,
        hasMore: result.hasMore,
        mcpDiscovery,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'search',
          sessionId: ctx.sessionId,
          name: `tool-search-${query}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            query,
            maxResults,
            totalCount: result.totalCount,
            resultCount: result.tools.length,
            loadedCount: result.loadedTools.length,
            mcpDiscoveryCount: mcpDiscovery.length,
          },
        }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('Tool search failed', { error: message });
    return {
      ok: false,
      error: `工具搜索失败: ${message}`,
      code: 'SEARCH_ERROR',
    };
  }
}

class ToolSearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeToolSearch(args, ctx, canUseTool, onProgress);
  }
}

export const toolSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ToolSearchHandler();
  },
};
