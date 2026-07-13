// ContextAssembly - artifact 修复 / 工具准备 推理 helper（从 inference.ts 纯结构性抽出，零行为改动）。
// 输出 token 上限、artifact 修复模式判定/工具过滤/maxTokens 上限、等待进度心跳、assistant delta 发射等。
import type { ToolCall, ToolDefinition } from '../../../../shared/contract';
import type { ModelResponse } from '../../../agent/loopTypes';
import type { ModelConfig } from '../../../../shared/contract/model';
import type { InferenceOptions } from '../../../model/types';
import {
  getArtifactRepairToolPolicy,
  isArtifactRepairWritePriority as isArtifactRepairWritePriorityForGuard,
} from '../artifactRepairGuard';
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

export function emitToolSchemaSnapshot(ctx: ContextAssemblyCtx, tools: ToolDefinition[]): void {
  if (tools.length === 0) return;
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
