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
import { estimateTokens } from '../../../context/tokenEstimator';
import { DEFERRED_TOOL_LOADING } from '../../../../shared/constants/tools';
import { readDeferredToolInjectionSchemas } from '../../dispatch/toolDefinitions';
import { boundSingleInjection } from '../../../services/toolSearch/singleInjectionCeiling';
import { descriptionContextFromModelConfig } from '../../../services/toolSearch/sentToolSchema';

const MAX_RESULTS_HARD_CAP = DEFERRED_TOOL_LOADING.SEARCH_MAX_RESULTS_HARD_CAP;
const DEFAULT_MAX_RESULTS = DEFERRED_TOOL_LOADING.SEARCH_DEFAULT_MAX_RESULTS;
const SINGLE_INJECTION_TOKEN_CEILING = DEFERRED_TOOL_LOADING.SINGLE_INJECTION_TOKEN_CEILING;
const EXPLICIT_SELECT_TOKEN_CEILING = DEFERRED_TOOL_LOADING.EXPLICIT_SELECT_INJECTION_TOKEN_CEILING;

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
    // scope 判据前置：discovery 会真的把 lazy stdio server 拉起来（起子进程），
    // 范围外的拉起来结果也会被丢掉，白起——收窄生效时只发现范围内的
    const scopedMcpServerIds = normalizeWorkbenchToolScope(ctx.toolScope)?.allowedMcpServerIds;
    let mcpDiscovery: McpDiscoveryEntry[] = [];
    try {
      mcpDiscovery = await getMCPClient().discoverLazyServersForSearch(query, scopedMcpServerIds, ctx.abortSignal);
    } catch (discoveryError) {
      ctx.logger.warn('Lazy MCP discovery during tool search failed', {
        error: discoveryError instanceof Error ? discoveryError.message : String(discoveryError),
      });
    }

    const result = await service.searchTools(query, {
      maxResults,
      includeMCP: true,
      sessionId: ctx.sessionId,
      ...(ctx.deniedToolNames?.length ? { deniedToolNames: ctx.deniedToolNames } : {}),
    });

    // 与 mcpUnified 同一份口径：本轮收窄生效时，不把范围外的工具搜出来——
    // 搜出来模型照单点名、调用在 dispatch 门挨挡，「看见却调不动」比看不见更误导。
    // 两列同走完整 scope 门（MCP 与连接器两侧同口径）；计数对齐过滤后的列表，
    // 否则「找到 N 个」与列出的条目对不上；hasMore 保留服务真值——
    // 范围内匹配超过 maxResults 时模型该知道还能缩关键词
    if (scopedMcpServerIds?.length || normalizeWorkbenchToolScope(ctx.toolScope)?.allowedConnectorIds?.length) {
      result.tools = result.tools.filter((tool) =>
        isToolNameAllowedByWorkbenchScope(tool.name, ctx.toolScope));
      result.loadedTools = result.loadedTools.filter((name) =>
        isToolNameAllowedByWorkbenchScope(name, ctx.toolScope));
      result.totalCount = result.tools.length;
      if (scopedMcpServerIds?.length) {
        mcpDiscovery = mcpDiscovery.filter((entry) => scopedMcpServerIds.includes(entry.serverName));
      }
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
      const output = fitTextToTokenCeiling(
        `未找到匹配 "${query}" 的工具。${discoveryHint}${capabilityHint}\n\n提示：\n- 尝试使用更通用的关键字\n- 使用 "select:工具名" 直接加载已知工具\n- 核心工具（bash, read_file 等）无需搜索`,
        SINGLE_INJECTION_TOKEN_CEILING,
      );
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

    const modelContext = descriptionContextFromModelConfig(ctx.modelConfig);
    const decision = enforceSingleInjectionCeiling(result, {
      explicitSelect: query.trim().startsWith('select:'),
      sessionId: ctx.sessionId,
      descriptionContext: modelContext.context,
      provider: modelContext.provider,
    });
    if (!decision.ok) {
      return {
        ok: false,
        error: `显式选择 ${decision.name} 的完整 schema 超过单次注入总量上限（measured=${decision.measured} allowed=${decision.allowed}）。未注入部分 schema。`,
        code: 'INJECTION_CEILING',
      };
    }
    const output = decision.output;

    ctx.logger.info('ToolSearch done', {
      query,
      loaded: result.loadedTools.length,
      total: result.totalCount,
    });
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

interface SearchHit {
  name: string;
  description: string;
  source?: string;
  mcpServer?: string;
  loadable?: boolean;
  notCallableReason?: string;
  canonicalInvocation?: string;
}

interface SearchRenderResult {
  tools: SearchHit[];
  loadedTools: string[];
  hasMore: boolean;
  totalCount: number;
}

function renderToolSearchLines(result: SearchRenderResult, overCeiling: ReadonlySet<string>): string[] {
  const lines: string[] = [
    `找到 ${result.totalCount} 个匹配工具，已加载 ${result.loadedTools.length} 个：`,
    '',
  ];
  if (overCeiling.size > 0) {
    const selects = [...overCeiling].map((name) => `select:${name}`).join(', ');
    lines.push(`未自动注入完整 schema（超过单次注入上限）。使用 ${selects} 加载完整定义。`);
    lines.push('');
  }

  for (const tool of result.tools) {
    const sourceInfo = tool.source === 'mcp' && tool.mcpServer
      ? ` [MCP: ${tool.mcpServer}]`
      : '';
    const availability = tool.loadable === false
      ? `不可直接调用：${tool.notCallableReason || 'no direct tool definition is available'}`
      : '已加载，可直接调用';
    const isLoaded = result.loadedTools.includes(tool.name);
    lines.push(`• **${tool.name}**${isLoaded ? sourceInfo : ''}`);
    lines.push(`  ${tool.description}`);
    if (tool.loadable === false) {
      lines.push(`  ${availability}`);
      if (tool.canonicalInvocation) {
        lines.push(`  调用入口：${tool.canonicalInvocation}`);
      }
    } else if (isLoaded) {
      lines.push(`  ${availability}`);
      if (tool.canonicalInvocation) {
        lines.push(`  调用入口：${tool.canonicalInvocation}`);
      }
    } else if (overCeiling.has(tool.name)) {
      lines.push(`  完整 schema 超过单次注入上限，未自动注入。使用 select:${tool.name} 加载完整定义。`);
    } else {
      lines.push(`  未加载完整定义；使用 select:${tool.name} 加载。`);
    }
    lines.push('');
  }

  if (result.hasMore) {
    const remaining = result.totalCount - result.tools.length;
    lines.push(remaining > 0
      ? `还有 ${remaining} 个匹配结果，使用更具体的关键词缩小范围。`
      : '范围内可能还有更多匹配结果，使用更具体的关键词缩小范围。');
  }

  lines.push('');
  const notAutoLoaded = result.tools.filter(
    (tool) => tool.loadable !== false && !result.loadedTools.includes(tool.name) && !overCeiling.has(tool.name),
  );
  const overCeilingHits = result.tools.filter((tool) => overCeiling.has(tool.name));
  if (result.loadedTools.length > 0) {
    lines.push('已加载的工具现在可以直接使用。');
  } else if (notAutoLoaded.length === 0 && overCeilingHits.length === 0) {
    lines.push('没有新工具被加载；不可直接调用的结果只作为搜索线索。');
  }
  if (overCeilingHits.length > 0) {
    lines.push(`未自动注入完整 schema（超过单次注入上限）。使用 select:工具名 加载：${overCeilingHits.map((tool) => `select:${tool.name}`).join(', ')}。`);
  }
  if (notAutoLoaded.length > 0) {
    lines.push('其余匹配只返回名称和短描述，未注入完整 schema；需要时使用 select:工具名。');
  }
  return lines;
}

function namesOnlyText(result: SearchRenderResult): string {
  return [
    `找到 ${result.totalCount} 个匹配工具，已加载 ${result.loadedTools.length} 个：`,
    '',
    ...result.tools.flatMap((tool) => [`• **${tool.name}**`, '']),
    '搜索结果已按单次注入预算裁剪；使用 select:工具名加载工具。',
  ].join('\n');
}

function enforceSingleInjectionCeiling(
  result: SearchRenderResult & { insertedLoads?: readonly { name: string; token: number }[] },
  options: {
    explicitSelect: boolean;
    sessionId: string;
    descriptionContext?: { provider?: string; model?: string };
    provider?: string;
  },
): { ok: true; output: string } | { ok: false; measured: number; allowed: number; name: string } {
  const insertedLoads = result.insertedLoads ?? [];
  const freshNames = insertedLoads.map((claim) => claim.name);
  const measurable = readDeferredToolInjectionSchemas(freshNames, options.descriptionContext, options.provider);
  const schemaTokens = measurable.reduce((sum, schema) => sum + (schema.sentTokens ?? 0), 0);
  const ceiling = options.explicitSelect ? EXPLICIT_SELECT_TOKEN_CEILING : SINGLE_INJECTION_TOKEN_CEILING;
  const fullText = renderToolSearchLines(result, new Set()).join('\n');
  const bounded = boundSingleInjection({
    text: fullText,
    namesText: namesOnlyText(result),
    schemas: measurable,
    schemaTokens,
    ceiling,
  });
  if (options.explicitSelect) {
    if (!bounded.fitsSchemas) {
      getToolSearchService().rollbackInserted(insertedLoads, options.sessionId);
      result.loadedTools = result.loadedTools.filter((name) => !freshNames.includes(name));
      return {
        ok: false,
        measured: bounded.measured,
        allowed: ceiling,
        name: freshNames[0] || result.tools[0]?.name || 'tool',
      };
    }
    return { ok: true, output: bounded.text };
  }
  if (bounded.fitsSchemas) return { ok: true, output: bounded.text };

  const overCeiling = new Set(freshNames);
  getToolSearchService().rollbackInserted(insertedLoads, options.sessionId);
  result.loadedTools = result.loadedTools.filter((name) => !overCeiling.has(name));
  return {
    ok: true,
    output: fitTextToTokenCeiling(
      fitToolSearchOutput(renderToolSearchLines(result, overCeiling), result),
      SINGLE_INJECTION_TOKEN_CEILING,
    ),
  };
}

function fitTextToTokenCeiling(text: string, ceiling: number): string {
  if (estimateTokens(text) <= ceiling) return text;
  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(0, middle);
    if (estimateTokens(candidate) <= ceiling) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function fitToolSearchOutput(
  lines: string[],
  result: { tools: Array<{ name: string; description: string }>; loadedTools: string[]; hasMore: boolean; totalCount: number },
): string {
  const full = lines.join('\n');
  if (estimateTokens(full) <= SINGLE_INJECTION_TOKEN_CEILING) return full;

  const compactLines = [
    `找到 ${result.totalCount} 个匹配工具，已加载 ${result.loadedTools.length} 个：`,
    '',
    ...result.tools.flatMap((tool) => [
      `• **${tool.name}**`,
      `  ${tool.description.slice(0, 120)}`,
      '',
    ]),
    ...(result.hasMore ? ['使用更具体的关键词缩小范围。', ''] : []),
    '搜索结果已按单次注入预算裁剪；需要完整工具定义时使用 select:工具名。',
  ];
  if (estimateTokens(compactLines.join('\n')) <= SINGLE_INJECTION_TOKEN_CEILING) {
    return compactLines.join('\n');
  }

  const namesOnly = [
    `找到 ${result.totalCount} 个匹配工具，已加载 ${result.loadedTools.length} 个：`,
    '',
    ...result.tools.flatMap((tool) => [`• **${tool.name}**`, '']),
    '搜索结果已按单次注入预算裁剪；使用 select:工具名加载工具。',
  ].join('\n');
  if (estimateTokens(namesOnly) <= SINGLE_INJECTION_TOKEN_CEILING) return namesOnly;
  let low = 0;
  let high = namesOnly.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = namesOnly.slice(0, middle);
    if (estimateTokens(candidate) <= SINGLE_INJECTION_TOKEN_CEILING) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
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
