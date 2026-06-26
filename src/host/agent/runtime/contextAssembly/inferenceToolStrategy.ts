// ContextAssembly - 模型决策的工具策略诊断（从 inference.ts 纯结构性抽出，零行为改动）。
// programmatic tool calling 的 token savings 估算/provider usage 快照/fallback 结果回填决策。
import type { ToolDefinition } from '../../../../shared/contract';
import type { ModelResponse } from '../../../agent/loopTypes';
import type {
  ModelDecisionEventData,
  ModelProviderHealthSnapshot,
  ModelToolStrategyDiagnostics,
  ModelToolTokenSavingsProviderReport,
  ModelToolTokenSavingsProviderUsage,
} from '../../../../shared/contract/modelDecision';
import { estimateTokens } from '../../../context/tokenOptimizer';
import { getConfigService } from '../../../services';
import { buildModelProviderIdentity } from '../../../model/modelDecision';
import { getProviderHealthMonitor } from '../../../model/providerHealthMonitor';
import { formatFallbackEndpoint } from './inferenceProviderFallback';

function extractMcpServerId(tool: ToolDefinition): string | undefined {
  if (tool.mcpServer) return tool.mcpServer;
  const doubleUnderscore = /^mcp__(.+?)__/.exec(tool.name)?.[1];
  if (doubleUnderscore) return doubleUnderscore;
  return /^mcp_([^_]+)_/.exec(tool.name)?.[1];
}

function buildProviderUsageSnapshot(usage: ModelResponse['usage'] | undefined): ModelToolTokenSavingsProviderUsage | undefined {
  if (!usage) return undefined;
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return undefined;
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens));
  return {
    source: 'model-response-usage',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function buildProviderReportedSavingsSnapshot(usage: ModelResponse['usage'] | undefined): ModelToolTokenSavingsProviderReport | undefined {
  const savedTokens = usage?.providerReportedSavedTokens;
  if (typeof savedTokens !== 'number' || !Number.isFinite(savedTokens) || savedTokens < 0) return undefined;
  return {
    source: 'provider-reported',
    savedTokens: Math.trunc(savedTokens),
  };
}

function formatProviderUsageDetail(providerUsage: ModelToolTokenSavingsProviderUsage | undefined): string {
  if (!providerUsage) return '真实账单以 provider usage 为准。';
  return `本轮 provider usage 已回传：输入 ${providerUsage.inputTokens} / 输出 ${providerUsage.outputTokens} tokens；真实账单以 provider usage 为准。`;
}

function formatProviderReportedSavingsDetail(
  providerReport: ModelToolTokenSavingsProviderReport,
  providerUsage: ModelToolTokenSavingsProviderUsage | undefined,
): string {
  const usageDetail = providerUsage
    ? `本轮 provider usage 已回传：输入 ${providerUsage.inputTokens} / 输出 ${providerUsage.outputTokens} tokens。`
    : '本轮 provider usage 未回传。';
  return `provider 已回传 programmatic tool saved tokens：${providerReport.savedTokens} tokens；${usageDetail}`;
}

function buildRuntimeProviderHealthSnapshot(provider: string): ModelProviderHealthSnapshot {
  const health = getProviderHealthMonitor().getHealth(provider);
  const sampledAt = Date.now();
  if (!health) {
    return {
      provider,
      status: 'unknown',
      sampledAt,
    };
  }
  return {
    provider: health.provider,
    status: health.status,
    sampledAt,
    latencyP50: health.latencyP50,
    latencyP95: health.latencyP95,
    errorRate: health.errorRate,
    lastSuccessAt: health.lastSuccessAt,
    lastErrorAt: health.lastErrorAt,
    consecutiveErrors: health.consecutiveErrors,
  };
}

function applyFallbackResultToModelDecision(
  decision: ModelDecisionEventData,
  response: ModelResponse,
): ModelDecisionEventData {
  const fallback = response.fallback;
  const finalProvider = response.actualProvider ?? fallback?.to.provider;
  const finalModel = response.actualModel ?? fallback?.to.model;
  if (!fallback || !finalProvider || !finalModel) return decision;
  const from = formatFallbackEndpoint(fallback.from);
  const to = formatFallbackEndpoint({ provider: finalProvider, model: finalModel });
  const isCapabilityFallback = fallback.category === 'capability';
  const capability = fallback.reason;
  let providerIdentity: ModelDecisionEventData['providerIdentity'];
  try {
    providerIdentity = buildModelProviderIdentity(finalProvider, getConfigService().getSettings().models?.providers);
  } catch {
    providerIdentity = undefined;
  }
  const { providerIdentity: _previousProviderIdentity, ...decisionWithoutProviderIdentity } = decision;
  return {
    ...decisionWithoutProviderIdentity,
    ...(isCapabilityFallback
      ? {
          requestedProvider: fallback.from.provider,
          ...(fallback.from.model ? { requestedModel: fallback.from.model } : {}),
        }
      : {}),
    resolvedProvider: finalProvider,
    resolvedModel: finalModel,
    reason: isCapabilityFallback && capability === 'vision' ? 'capability-vision' : 'fallback-availability',
    fallbackFrom: from,
    strategySummary: isCapabilityFallback
      ? `原模型 ${from} 缺少 ${capability} 能力，切到 ${to} 完成当前任务。`
      : `原模型 ${from} 不可用，切到 ${to} 完成当前任务。`,
    speedPolicy: isCapabilityFallback ? decision.speedPolicy : 'fallback-recovery',
    providerHealthSnapshot: buildRuntimeProviderHealthSnapshot(finalProvider),
    ...(providerIdentity ? { providerIdentity } : {}),
  };
}

export function buildToolStrategyDiagnostics(
  tools: ToolDefinition[],
  usage?: ModelResponse['usage'],
): ModelToolStrategyDiagnostics {
  const toolNames = tools.map((tool) => tool.name);
  const toolNamesPreview = toolNames.slice(0, 8);
  const mcpServerIds = Array.from(new Set(
    tools
      .map(extractMcpServerId)
      .filter((serverId): serverId is string => Boolean(serverId)),
  )).sort();
  const mcpToolCount = tools.filter((tool) => tool.source === 'mcp' || Boolean(extractMcpServerId(tool))).length;
  const estimatedToolSpecTokens = tools.reduce((sum, tool) => {
    const schemaText = JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    return sum + estimateTokens(schemaText);
  }, 0);
  const providerUsage = buildProviderUsageSnapshot(usage);
  const providerReport = buildProviderReportedSavingsSnapshot(usage);
  return {
    visibleToolCount: tools.length,
    ...(toolNames.length > 0 ? { toolNamesPreview } : {}),
    mcpToolCount,
    ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
    programmaticToolCalling: tools.length > 0 ? 'available' : 'unavailable',
    programmaticToolCount: tools.length,
    tokenSavings: tools.length > 0
      ? providerReport
        ? {
            status: 'provider-reported',
            savedTokens: providerReport.savedTokens,
            detail: formatProviderReportedSavingsDetail(providerReport, providerUsage),
            measurement: {
              savingsSource: 'provider-reported',
              usageSource: providerUsage ? 'model-response-usage' : 'unavailable',
              providerReportedSavings: true,
            },
            providerReport,
            ...(providerUsage ? { providerUsage } : {}),
          }
        : {
          status: 'estimated',
          savedTokens: estimatedToolSpecTokens,
          detail: `估算值：${tools.length} 个工具的 name/description/inputSchema 若写入普通消息上下文，约占 ${estimatedToolSpecTokens} tokens；${formatProviderUsageDetail(providerUsage)}`,
          measurement: {
            savingsSource: 'tool-spec-local-estimate',
            usageSource: providerUsage ? 'model-response-usage' : 'unavailable',
            providerReportedSavings: false,
          },
          basis: {
            source: 'tool-spec-local-estimate',
            toolCount: tools.length,
            previewToolCount: toolNamesPreview.length,
            fields: ['name', 'description', 'inputSchema'],
          },
          ...(providerUsage ? { providerUsage } : {}),
        }
      : {
          status: 'not-measured',
          detail: providerUsage
            ? `本轮没有可见程序化工具，token saved 不计量；本轮 provider usage 已回传：输入 ${providerUsage.inputTokens} / 输出 ${providerUsage.outputTokens} tokens。`
            : '本轮没有可见程序化工具，token saved 不计量。',
          measurement: {
            savingsSource: 'not-measured',
            usageSource: providerUsage ? 'model-response-usage' : 'unavailable',
            providerReportedSavings: false,
          },
          ...(providerUsage ? { providerUsage } : {}),
        },
  };
}

export function buildModelDecisionWithToolStrategy(
  decision: ModelDecisionEventData | undefined,
  tools: ToolDefinition[],
  usage?: ModelResponse['usage'],
  response?: ModelResponse,
): ModelDecisionEventData | undefined {
  if (!decision) return undefined;
  const toolStrategy = buildToolStrategyDiagnostics(tools, usage);
  const decisionWithTools = {
    ...decision,
    toolPolicy: tools.length > 0 ? decision.toolPolicy ?? 'runtime-checked' : 'disabled-by-model',
    toolStrategy,
  };
  return response ? applyFallbackResultToModelDecision(decisionWithTools, response) : decisionWithTools;
}
