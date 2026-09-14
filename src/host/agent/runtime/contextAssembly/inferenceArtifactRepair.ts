// ContextAssembly - artifact 修复 / 工具准备 推理 helper（从 inference.ts 纯结构性抽出，零行为改动）。
// 输出 token 上限、artifact 修复模式判定/工具过滤/maxTokens 上限、等待进度心跳、assistant delta 发射等。
import { createHash } from 'crypto';
import type { ToolCall, ToolDefinition } from '../../../../shared/contract';
import { CONTEXT_LEDGER } from '../../../../shared/constants';
import type { ModelResponse } from '../../../agent/loopTypes';
import type { ModelConfig } from '../../../../shared/contract/model';
import type { InferenceOptions } from '../../../model/types';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import { getToolSchemaCache } from '../../../telemetry/toolSchemaCache';
import {
  getArtifactRepairToolPolicy,
  isArtifactRepairWritePriority as isArtifactRepairWritePriorityForGuard,
} from '../artifactRepairGuard';
import { persistStreamedPartialBeforeResend, STREAM_BREAK_SEGMENT_MARKER } from './systemContextStack';
import { retryEvents } from '../../../model/providers/retryStrategy';
import type { ContextAssemblyCtx } from './shared';
import { logger } from './shared';

const ARTIFACT_REPAIR_RECOVERY_MAX_TOKENS = 16_384;
const ARTIFACT_REPAIR_TARGETED_EDIT_MAX_TOKENS = 32_768;
const ARTIFACT_REPAIR_WRITE_MAX_TOKENS = 65_536;
const ARTIFACT_MODEL_WAIT_HEARTBEAT_MS = 15_000;

export function capOutputTokens(config: ModelConfig, options: InferenceOptions | undefined): ModelConfig {
  const maxOutputTokens = options?.maxOutputTokens;
  if (!maxOutputTokens || maxOutputTokens <= 0) return config;
  const current = typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens)
    ? config.maxTokens
    : maxOutputTokens;
  return {
    ...config,
    maxTokens: Math.min(current, maxOutputTokens),
  };
}

export function startArtifactModelWaitProgress(
  ctx: ContextAssemblyCtx,
  options: {
    artifactRequest: boolean;
    artifactRepairActive: boolean;
    artifactRepairWritePriority: boolean;
  },
): () => void {
  if (!options.artifactRequest && !options.artifactRepairActive) {
    return () => undefined;
  }

  const startedAt = Date.now();
  const baseStep = options.artifactRepairActive
    ? options.artifactRepairWritePriority
      ? '正在写入 artifact 修复补丁...'
      : '正在分析 artifact 修复方案...'
    : '正在生成 artifact 内容...';

  ctx.taskProgress.emitTaskProgress('generating', baseStep);
  const timer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    ctx.taskProgress.emitTaskProgress(
      'generating',
      `${baseStep} 已等待 ${elapsedSeconds} 秒，模型仍在处理。`,
    );
  }, ARTIFACT_MODEL_WAIT_HEARTBEAT_MS);

  return () => {
    clearInterval(timer);
  };
}

export function getNetworkRetryBudget(errMsg: string, errCode: string | undefined, artifactRepairActive: boolean): number {
  if (!artifactRepairActive) return 1;

  const isSlowProviderTimeout =
    /request timeout|timeout after \d+ms|timed out/i.test(errMsg)
    || /ETIMEDOUT/i.test(errCode || '');
  if (isSlowProviderTimeout) return 1;

  const isFastConnectionFailure =
    /TLS connection|network socket disconnected|socket hang up|ECONNRESET|ECONNREFUSED|ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac/i.test(errMsg)
    || /ECONNRESET|ECONNREFUSED/i.test(errCode || '');
  if (isFastConnectionFailure) return 2;

  return 1;
}

/**
 * loop 层网络瞬态错误重试（从 inference.ts 纯结构性抽出，零行为改动；N-STREAM-RESUME-KNIFE3
 * 时并入「先保片段再重发」——ADR-068 刀 3 收编 as-built 备注 1：network retry 原本在已吐
 * delta 后整轮重发且 resetStreamedContent() 丢片段）。返回重试结果；不重试/重试失败返回
 * undefined，调用方回落终错路径。
 */
// loop 层重发前的固定等待（刀 3 既有行为）：retryEvents reconnect 的 delay 展示同一值，
// 钉成一个常量防止两处漂移。
const NETWORK_RETRY_DELAY_MS = 2000;

export async function runNetworkErrorRecovery(
  ctx: ContextAssemblyCtx,
  errorInfo: { errMsg: string; errCode: string | undefined; isSlowProviderTimeout: boolean },
): Promise<ModelResponse | undefined> {
  const { errMsg, errCode, isSlowProviderTimeout } = errorInfo;
  const isNetworkError = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|TLS connection|ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac|network socket disconnected|request timeout|timeout after \d+ms|timed out/i.test(errMsg)
    || /ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(errCode || '');
  const maxNetworkRetries = getNetworkRetryBudget(
    errMsg,
    errCode,
    Boolean(ctx.runtime.artifact.repairGuard),
  );
  const networkRetryCount = ctx.runtime.contextHealth.networkRetryCount ?? (ctx.inferenceRecovery._networkRetried ? 1 : 0);
  const shouldRetryNetworkError =
    isNetworkError
    && networkRetryCount < maxNetworkRetries
    && ctx.runtime.inferenceOptions?.disableRuntimeNetworkRetry !== true
    && !(ctx.runtime.artifact.repairGuard && isSlowProviderTimeout);
  if (!shouldRetryNetworkError) return undefined;
  ctx.inferenceRecovery._networkRetried = true;
  ctx.runtime.contextHealth.setNetworkRetryCount(networkRetryCount + 1);
  // ADR-068 刀 4（D5 UI 信号）：loop 层网络重发与 adapter 层续接同形——发 stream_reconnecting
  // 让 renderer 在同一 streaming 消息内嵌「连接中断，正在续接 n/N」状态行。loop 层重发
  // 永远是诚实分段（断点 partial 已定格落库，续答另起一段），segment 恒 'b2'。
  ctx.runtime.onEvent({
    type: 'stream_reconnecting',
    data: {
      turnId: ctx.runtime.turn.currentTurnId,
      attempt: networkRetryCount + 1,
      maxReconnects: maxNetworkRetries,
      segment: 'b2',
    },
  });
  retryEvents.emit('reconnect', {
    provider: ctx.runtime.modelConfig?.provider ?? 'unknown',
    attempt: networkRetryCount + 1,
    maxReconnects: maxNetworkRetries,
    delay: NETWORK_RETRY_DELAY_MS,
    error: errMsg,
    segment: 'b2',
  });
  // ADR-068 刀 3 收编：network retry 原本整轮重发还丢片段——先保片段再重发（重发输出
  // 另起一段不 append 拼缝，与 adapter 层同一边界）。
  persistStreamedPartialBeforeResend(ctx, STREAM_BREAK_SEGMENT_MARKER, 'loop 层网络重发');
  logger.warn(`[AgentLoop] Network error "${errMsg}" (code=${errCode}), retrying inference (${ctx.runtime.contextHealth.networkRetryCount}/${maxNetworkRetries})...`);
  await new Promise(r => setTimeout(r, NETWORK_RETRY_DELAY_MS));
  try {
    const retryResult = await ctx.inference();
    ctx.inferenceRecovery._networkRetried = false;
    ctx.runtime.contextHealth.setNetworkRetryCount(0);
    return retryResult;
  } catch (retryErr) {
    if ((ctx.runtime.contextHealth.networkRetryCount ?? 0) >= maxNetworkRetries) {
      ctx.inferenceRecovery._networkRetried = false;
      ctx.runtime.contextHealth.setNetworkRetryCount(0);
    }
    logger.error('[AgentLoop] Network retry also failed:', retryErr);
  }
  return undefined;
}

export function isArtifactRepairMode(ctx: ContextAssemblyCtx): boolean {
  return Boolean(ctx.runtime.artifact.repairGuard?.targetFile);
}

export function emitAssistantMessageDelta(
  ctx: ContextAssemblyCtx,
  path: 'content' | 'reasoning',
  text: string | undefined,
): void {
  if (!text) return;
  ctx.runtime.onEvent({
    type: 'message_delta',
    data: {
      role: 'assistant',
      path,
      op: 'append',
      text,
      turnId: ctx.runtime.turn.currentTurnId,
      messageId: ctx.runtime.turn.currentTurnId,
      deltaSeq: ctx.runtime.turn.nextMessageDeltaSeq(),
      ...(ctx.runtime.historyVisibility === 'meta' ? { isMeta: true } : {}),
    },
  });
}

export function buildArtifactValidationAttemptCompletionResponse(targetFile: string): ModelResponse {
  const toolCall: ToolCall = {
    id: `call_artifact_validation_completion_${Date.now().toString(36)}`,
    name: 'attempt_completion',
    arguments: {
      summary: `Artifact validation passed for ${targetFile}. Requesting goal verification.`,
    },
  };
  return {
    type: 'tool_use',
    toolCalls: [toolCall],
    contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
    finishReason: 'tool_calls',
    runtimeDiagnostics: {
      artifactValidationAttemptCompletion: {
        targetFile,
      },
    },
  };
}

export interface ToolSchemaSnapshot {
  schemaHash: string;
  toolNames: string[];
  schemaJson: string;
  cacheStored?: boolean;
}

export function buildToolSchemaSnapshot(
  tools: ToolDefinition[],
): ToolSchemaSnapshot {
  const orderedTools = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const toolNames = orderedTools.map((tool) => tool.name);
  const schemaJson = JSON.stringify(orderedTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })));
  const schemaHash = createHash(CONTEXT_LEDGER.SCHEMA_HASH_ALGORITHM)
    .update(schemaJson)
    .digest('hex');
  return { schemaHash, toolNames, schemaJson };
}

export function emitToolSchemaSnapshot(
  ctx: ContextAssemblyCtx,
  tools: ToolDefinition[],
): ToolSchemaSnapshot {
  const snapshot = buildToolSchemaSnapshot(tools);
  const { schemaHash, toolNames, schemaJson } = snapshot;
  snapshot.cacheStored = getToolSchemaCache().store(schemaHash, schemaJson);
  const timestamp = Date.now();
  getContextEventLedger().upsertEvents([
    {
      id: '',
      sessionId: ctx.runtime.sessionId,
      agentId: ctx.runtime.agentId,
      invocationId: ctx.runtime.turn.currentTurnId,
      sourceKind: CONTEXT_LEDGER.SOURCE_KIND.TOOL_SCHEMA_SNAPSHOT,
      sourceDetail: schemaHash,
      reason: `${toolNames.length} active tools`,
      toolNames,
      schemaHash,
      timestamp,
    },
    {
      id: '',
      sessionId: ctx.runtime.sessionId,
      agentId: ctx.runtime.agentId,
      invocationId: ctx.runtime.turn.currentTurnId,
      sourceKind: CONTEXT_LEDGER.SOURCE_KIND.MODEL_BINDING,
      sourceDetail: `${ctx.runtime.modelConfig.provider}/${ctx.runtime.modelConfig.model}`,
      reason: 'model binding',
      model: ctx.runtime.modelConfig.model,
      provider: ctx.runtime.modelConfig.provider,
      timestamp,
    },
  ]);
  // T3b: 工具表被砍到 0 时最该报警，之前这里直接 return 让 UI/遥测那条路静默
  // （2026-08-07 排查报告 §6）——0 工具也照发，toolCount:0 由下游消费者按空表处理。
  ctx.runtime.onEvent({
    type: 'tool_schema_snapshot',
    data: {
      turnId: ctx.runtime.turn.currentTurnId,
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema as unknown as Record<string, unknown> | undefined,
        requiresPermission: tool.requiresPermission,
        permissionLevel: tool.permissionLevel,
      })),
    },
  });
  return snapshot;
}

export function isArtifactRepairWritePriority(ctx: ContextAssemblyCtx): boolean {
  return isArtifactRepairWritePriorityForGuard(ctx.runtime.artifact.repairGuard);
}

export function isArtifactRepairFullRewritePriority(ctx: ContextAssemblyCtx): boolean {
  return getArtifactRepairToolPolicy(ctx.runtime.artifact.repairGuard)?.fullRewritePriority ?? false;
}

export function filterToolsForArtifactRepair<T extends { name: string }>(
  tools: T[],
  ctx: ContextAssemblyCtx,
): T[] {
  const policy = getArtifactRepairToolPolicy(ctx.runtime.artifact.repairGuard);
  if (!policy) return tools;
  return tools.filter((tool) => policy.allowlist.has(tool.name));
}

export function dedupeToolDefinitions<T extends { name: string }>(tools: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  const duplicates: string[] = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.push(tool.name);
      continue;
    }
    seen.add(tool.name);
    deduped.push(tool);
  }

  if (duplicates.length > 0) {
    logger.warn('[AgentLoop] Deduped duplicate tool definitions', {
      duplicateNames: [...new Set(duplicates)],
      before: tools.length,
      after: deduped.length,
    });
  }

  return deduped;
}

export function capArtifactRepairMaxTokens(
  ctx: ContextAssemblyCtx,
  config: typeof ctx.runtime.modelConfig,
): typeof ctx.runtime.modelConfig {
  if (!ctx.runtime.artifact.repairGuard) return config;
  const currentMaxTokens = config.maxTokens;
  if (typeof currentMaxTokens !== 'number') return config;

  const cap = isArtifactRepairFullRewritePriority(ctx)
    ? ARTIFACT_REPAIR_WRITE_MAX_TOKENS
    : isArtifactRepairWritePriority(ctx)
      ? ARTIFACT_REPAIR_TARGETED_EDIT_MAX_TOKENS
      : ARTIFACT_REPAIR_RECOVERY_MAX_TOKENS;
  if (currentMaxTokens <= cap) return config;
  return {
    ...config,
    maxTokens: cap,
  };
}
