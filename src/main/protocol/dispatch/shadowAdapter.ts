// ============================================================================
// Protocol Adapter — 旧 ToolContext → protocol ToolContext 的桥接 + 执行入口
//
// 历史：原为 shadow-compare 适配层（P0-5 A 阶段），shadow 机制已退役，
// 仅保留 protocol 执行入口（executePocToolViaProtocol）。
// P0-6.3 搬到 protocol/dispatch/ 下，彻底脱离 tools/ 目录，消除 madge phantom cycle。
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type {
  ToolContext as ProtocolToolContext,
  CanUseToolFn,
  CanUseToolResult,
  FileReadCache,
} from '../tools';
import type { AgentEvent } from '../events';
import type { ToolContext as LegacyToolContext, ToolExecutionResult } from '../../tools/types';
import { getProtocolRegistry } from '../../tools/protocolRegistry';

// ----------------------------------------------------------------------------
// FileReadCache — 进程级单例，避免每次构造 ctx 时重建缓存
// ----------------------------------------------------------------------------

class InMemoryFileCache implements FileReadCache {
  private readonly store = new Map<string, { content: string; mtimeMs: number }>();

  get(absPath: string): { content: string; mtimeMs: number } | undefined {
    return this.store.get(absPath);
  }

  set(absPath: string, content: string, mtimeMs: number): void {
    this.store.set(absPath, { content, mtimeMs });
  }
}

const sharedFileCache = new InMemoryFileCache();

// ----------------------------------------------------------------------------
// Protocol ToolContext 构造
// ----------------------------------------------------------------------------

export interface ProtocolContextInput {
  sessionId?: string;
  workingDirectory: string;
  abortSignal?: AbortSignal;
  legacyCtx: LegacyToolContext;
  /**
   * 跨工具调度 resolver。调用方（例如 ProtocolToolResolver.execute）注入，
   * 避免 shadowAdapter 反向 import toolResolver 形成静态 cycle。
   * 外部独立调用 executePocToolViaProtocol 不需要 resolver（无跨工具调度场景）。
   */
  resolver?: unknown;
}

/** 从 legacy ToolContext 构造 protocol ToolContext，用于 executePocToolViaProtocol */
export function buildProtocolContext(input: ProtocolContextInput): ProtocolToolContext {
  const logger = createLogger('ToolProtocol');
  const legacy = input.legacyCtx as unknown as Record<string, unknown> | undefined;

  const legacyEmitEvent = legacy?.emitEvent as ((event: string, data: unknown) => void) | undefined;
  const wrapEmit = (event: AgentEvent) => {
    if (legacyEmitEvent && typeof legacyEmitEvent === 'function') {
      legacyEmitEvent((event as { type?: string }).type ?? 'unknown', event);
    }
  };

  const subagent = legacy
    ? {
        agentId: legacy.agentId as string | undefined,
        agentName: legacy.agentName as string | undefined,
        agentRole: legacy.agentRole as string | undefined,
        parentSessionId: legacy.sessionId as string | undefined,
        currentToolCallId: legacy.currentToolCallId as string | undefined,
        modifiedFiles: legacy.modifiedFiles as ReadonlySet<string> | undefined,
        messages: legacy.messages as readonly unknown[] | undefined,
        todos: legacy.todos as readonly unknown[] | undefined,
        attachments: legacy.currentAttachments as readonly unknown[] | undefined,
      }
    : undefined;

  const legacyIsPlanMode = legacy?.isPlanMode as (() => boolean) | undefined;
  const legacySetPlanMode = legacy?.setPlanMode as ((active: boolean) => void) | undefined;
  const planMode = (legacyIsPlanMode || legacySetPlanMode)
    ? {
        isActive: () => (legacyIsPlanMode ? legacyIsPlanMode() : false),
        enter: (_reason?: string) => legacySetPlanMode?.(true),
        exit: (_reason?: string) => legacySetPlanMode?.(false),
      }
    : undefined;

  return {
    sessionId: input.sessionId ?? 'protocol-unknown',
    workingDir: input.workingDirectory,
    abortSignal: input.abortSignal ?? new AbortController().signal,
    logger: {
      debug: (msg, meta) => logger.debug(msg, meta),
      info: (msg, meta) => logger.info(msg, meta),
      warn: (msg, meta) => logger.warn(msg, meta),
      error: (msg, meta) => logger.error(msg, meta as Error | undefined),
    },
    fileCache: sharedFileCache,
    emit: wrapEmit,
    modelCallback: legacy?.modelCallback as ((prompt: string) => Promise<string>) | undefined,
    currentToolCallId: legacy?.currentToolCallId as string | undefined,
    planMode,
    subagent,
    hookManager: legacy?.hookManager,
    planningService: legacy?.planningService,
    modelConfig: legacy?.modelConfig,
    resolver: input.resolver ?? (legacy?.resolver as unknown),
  };
}

/**
 * 真权限版 canUseTool — 桥接 legacy ToolContext.requestPermission 到 protocol CanUseToolFn。
 */
export function buildCanUseToolFromLegacy(
  legacyCtx: LegacyToolContext,
  toolName: string,
): CanUseToolFn {
  return async (_name, input, reason): Promise<CanUseToolResult> => {
    const type: 'file_read' | 'file_write' | 'file_edit' | 'command' | 'network' | 'dangerous_command' =
      ('file_path' in input || 'path' in input)
        ? 'file_read'
        : 'url' in input
          ? 'network'
          : 'command';

    try {
      const allowed = await legacyCtx.requestPermission({
        type,
        tool: toolName,
        details: input,
        reason: reason ?? `protocol tool ${toolName}`,
      });
      return allowed
        ? { allow: true }
        : { allow: false, reason: reason ?? 'denied by user' };
    } catch (err) {
      return {
        allow: false,
        reason: err instanceof Error ? err.message : 'permission check threw',
      };
    }
  };
}

// ----------------------------------------------------------------------------
// Protocol 执行入口
// ----------------------------------------------------------------------------

export interface ExecuteProtocolInput {
  toolName: string;
  params: Record<string, unknown>;
  workingDirectory: string;
  requestPermission: LegacyToolContext['requestPermission'];
  sessionId?: string;
  abortSignal?: AbortSignal;
}

/**
 * LLM 选中已在 protocol registry 里的 tool 名字时，toolExecutor 调本函数走 protocol 路径。
 * 把 ProtocolToolResult 适配回 ToolExecutionResult，让上层 streaming/cache/audit 不感知。
 */
export async function executePocToolViaProtocol(
  input: ExecuteProtocolInput,
): Promise<ToolExecutionResult> {
  try {
    const registry = getProtocolRegistry();
    if (!registry.has(input.toolName)) {
      return { success: false, error: `protocol tool not registered: ${input.toolName}` };
    }

    const handler = await registry.resolve(input.toolName);

    const legacyCtx = {
      workingDirectory: input.workingDirectory,
      requestPermission: input.requestPermission,
    } as unknown as LegacyToolContext;

    const ctx = buildProtocolContext({
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
      legacyCtx,
      abortSignal: input.abortSignal,
    });

    const canUseTool = buildCanUseToolFromLegacy(legacyCtx, input.toolName);

    const protoResult = await handler.execute(input.params, ctx, canUseTool);

    if (protoResult.ok) {
      const output = typeof protoResult.output === 'string'
        ? protoResult.output
        : JSON.stringify(protoResult.output);
      return {
        success: true,
        output,
        result: protoResult.output,
        metadata: protoResult.meta,
      };
    } else {
      return {
        success: false,
        error: protoResult.error,
        metadata: { code: protoResult.code, ...(protoResult.meta ?? {}) },
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
