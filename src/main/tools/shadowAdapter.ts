// ============================================================================
// Shadow Adapter — 旧 ToolContext / 旧 result → 新 protocol 签名 的桥接
//
// 仅在 TOOL_PROTOCOL_SHADOW=1 且 tool 在白名单里时被 toolExecutor 调用。
// 全程 fire-and-forget：
//   1. 用旧 ctx 构造新 ToolContext（字段裁剪 + 安全默认）
//   2. 用 always-allow 的 CanUseToolFn（权限已由旧路径检过，不重复问用户）
//   3. 解析 POC handler 并执行
//   4. diff 新旧结果，写 jsonl 日志
//
// 永不抛异常到调用方；永不延迟旧路径返回。
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '../services/infra/logger';
import type {
  ToolContext as ProtocolToolContext,
  CanUseToolFn,
  CanUseToolResult,
  ToolResult as ProtocolToolResult,
  FileReadCache,
} from '../protocol/tools';
import type { AgentEvent } from '../protocol/events';
import type { ToolContext as LegacyToolContext, ToolExecutionResult } from './types';
import { getProtocolRegistry, resolveShadowToolName } from './protocolRegistry';

const shadowLogger = createLogger('ToolShadow');

// ----------------------------------------------------------------------------
// FileReadCache — shadow 会话级别单例，避免每次新建打掉 cache 命中率
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
// Context 桥接
// ----------------------------------------------------------------------------

export interface ShadowBuildInput {
  sessionId?: string;
  workingDirectory: string;
  abortSignal?: AbortSignal;
  legacyCtx: LegacyToolContext;
}

/** 构造新 ToolContext。缺失字段用安全默认值填充 */
export function buildProtocolContext(input: ShadowBuildInput): ProtocolToolContext {
  const logger = createLogger('ToolProtocol');
  const legacy = input.legacyCtx as unknown as Record<string, unknown> | undefined;

  // 从 legacy ctx 提取扩展字段（passthrough）。legacy 形态不严格，全部走 cast。
  const legacyEmitEvent = legacy?.emitEvent as ((event: string, data: unknown) => void) | undefined;
  const wrapEmit = (event: AgentEvent) => {
    if (legacyEmitEvent && typeof legacyEmitEvent === 'function') {
      // 将 protocol AgentEvent 透传到 legacy emitEvent，event.type 作为事件名
      legacyEmitEvent((event as { type?: string }).type ?? 'unknown', event);
    }
  };

  // P0-5 ctx 扩展字段从 legacy 透传
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

  // planMode 从 legacy 的 setPlanMode/isPlanMode 函数对桥接成 controller 接口
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
    sessionId: input.sessionId ?? 'shadow-unknown',
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
    // ── P0-5 ctx 扩展字段 passthrough ──
    modelCallback: legacy?.modelCallback as ((prompt: string) => Promise<string>) | undefined,
    currentToolCallId: legacy?.currentToolCallId as string | undefined,
    planMode,
    subagent,
    hookManager: legacy?.hookManager,
    planningService: legacy?.planningService,
    modelConfig: legacy?.modelConfig,
    legacyToolRegistry: legacy?.toolRegistry,
  };
}

/**
 * 构造 always-allow 的 canUseTool。
 * 理由：shadow 只在旧路径**已经**通过权限检查后才触发，新路径重复问用户会出现
 * 两次权限弹窗。这里直接放行即可，实际权限行为由旧路径负责。
 */
export function buildAlwaysAllowCanUseTool(): CanUseToolFn {
  return async () => ({ allow: true });
}

/**
 * 真权限版 canUseTool — POC 名字直接走新路径调用时用（B 阶段）。
 * 桥接 legacy ToolContext.requestPermission 到新 CanUseToolFn 形态。
 *
 * 和 buildAlwaysAllowCanUseTool 的区别：B 阶段 LLM 直接调 ReadPoc，没有"旧路径已经
 * 检过权限"的前提，必须真问用户。
 */
export function buildCanUseToolFromLegacy(
  legacyCtx: LegacyToolContext,
  toolName: string,
): CanUseToolFn {
  return async (_name, input, reason): Promise<CanUseToolResult> => {
    // 简化映射：根据参数 key 推断 PermissionRequestData.type
    // POC 阶段不细分，统一走 'command'，让 confirmationGate 兜底
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
        reason: reason ?? `POC tool ${toolName}`,
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
// Shadow 执行 + diff
// ----------------------------------------------------------------------------

interface ShadowDiffRecord {
  ts: string;
  toolName: string;
  shadowName: string;
  legacySuccess: boolean;
  shadowOk: boolean;
  outputMatch: boolean;
  legacyError?: string;
  shadowError?: string;
  diffSummary?: string;
}

/** 将新 protocol result 压成可对比的字符串（简化 diff） */
function canonicalizeShadowOutput(result: ProtocolToolResult): string {
  if (!result.ok) return `ERR:${result.code ?? ''}:${result.error}`;
  const out = result.output;
  if (out == null) return 'OK:null';
  if (typeof out === 'string') return `OK:${out}`;
  if (typeof out === 'object' && 'content' in (out as Record<string, unknown>)) {
    return `OK:${String((out as Record<string, unknown>).content ?? '')}`;
  }
  if (typeof out === 'object' && 'stdout' in (out as Record<string, unknown>)) {
    return `OK:${String((out as Record<string, unknown>).stdout ?? '')}`;
  }
  try {
    return `OK:${JSON.stringify(out)}`;
  } catch {
    return 'OK:<unserializable>';
  }
}

function canonicalizeLegacyOutput(result: ToolExecutionResult): string {
  if (!result.success) return `ERR::${result.error ?? ''}`;
  // 旧 tool 可能把内容放在 result.output（string）或 result.result（unknown），
  // 优先看 output，fallback 到 result
  if (typeof result.output === 'string') return `OK:${result.output}`;
  const out = result.result;
  if (out == null) return 'OK:null';
  if (typeof out === 'string') return `OK:${out}`;
  if (typeof out === 'object' && 'content' in (out as Record<string, unknown>)) {
    return `OK:${String((out as Record<string, unknown>).content ?? '')}`;
  }
  if (typeof out === 'object' && 'stdout' in (out as Record<string, unknown>)) {
    return `OK:${String((out as Record<string, unknown>).stdout ?? '')}`;
  }
  try {
    return `OK:${JSON.stringify(out)}`;
  } catch {
    return 'OK:<unserializable>';
  }
}

function resolveDiffLogPath(): string {
  return path.resolve(process.cwd(), 'data/debug/tool-shadow-diff.jsonl');
}

async function appendDiffRecord(record: ShadowDiffRecord): Promise<void> {
  try {
    const logPath = resolveDiffLogPath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    shadowLogger.debug('write shadow diff failed', { err: (err as Error).message });
  }
}

// ----------------------------------------------------------------------------
// B 阶段：POC 名字直接走 protocol registry 的执行入口
// ----------------------------------------------------------------------------

export interface ExecutePocInput {
  toolName: string;
  params: Record<string, unknown>;
  workingDirectory: string;
  requestPermission: LegacyToolContext['requestPermission'];
  sessionId?: string;
  abortSignal?: AbortSignal;
}

/**
 * LLM 选了 POC 名字（如 ReadPoc）时，toolExecutor 调本函数走新路径。
 * 把 ProtocolToolResult 适配回 ToolExecutionResult，让上层 streaming/cache/audit 不感知。
 */
export async function executePocToolViaProtocol(
  input: ExecutePocInput,
): Promise<ToolExecutionResult> {
  try {
    const registry = getProtocolRegistry();
    if (!registry.has(input.toolName)) {
      return { success: false, error: `POC tool not registered: ${input.toolName}` };
    }

    const handler = await registry.resolve(input.toolName);

    // 构造一个轻量 legacyCtx 占位，buildProtocolContext 只用 workingDir 字段
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

    // B 阶段：真权限版 canUseTool（不再 always-allow）
    const canUseTool = buildCanUseToolFromLegacy(legacyCtx, input.toolName);

    const protoResult = await handler.execute(input.params, ctx, canUseTool);

    if (protoResult.ok) {
      // 旧 ToolExecutionResult.output 期待 string；POC output 通常是对象，做兼容
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

export interface RunShadowInput {
  toolName: string;
  params: Record<string, unknown>;
  legacyResult: ToolExecutionResult;
  legacyCtx: LegacyToolContext;
  workingDirectory: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
}

/**
 * 并行跑 protocol 路径 + diff。调用方 fire-and-forget 即可，本函数永不抛。
 * 返回 Promise 只是为了 test 能 await，生产代码无须 await。
 */
export async function runShadowCompare(input: RunShadowInput): Promise<void> {
  const shadowName = resolveShadowToolName(input.toolName);
  if (!shadowName) return;

  try {
    const registry = getProtocolRegistry();
    if (!registry.has(shadowName)) {
      shadowLogger.debug('shadow tool not registered', { shadowName });
      return;
    }

    const handler = await registry.resolve(shadowName);
    const ctx = buildProtocolContext({
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
      abortSignal: input.abortSignal,
      legacyCtx: input.legacyCtx,
    });
    const canUseTool = buildAlwaysAllowCanUseTool();

    const shadowResult = await handler.execute(input.params, ctx, canUseTool);

    const legacyCanon = canonicalizeLegacyOutput(input.legacyResult);
    const shadowCanon = canonicalizeShadowOutput(shadowResult);
    const outputMatch = legacyCanon === shadowCanon;

    const record: ShadowDiffRecord = {
      ts: new Date().toISOString(),
      toolName: input.toolName,
      shadowName,
      legacySuccess: input.legacyResult.success,
      shadowOk: shadowResult.ok,
      outputMatch,
      legacyError: input.legacyResult.success ? undefined : input.legacyResult.error,
      shadowError: shadowResult.ok ? undefined : shadowResult.error,
      diffSummary: outputMatch
        ? undefined
        : `legacy=${legacyCanon.slice(0, 200)} | shadow=${shadowCanon.slice(0, 200)}`,
    };

    await appendDiffRecord(record);

    if (!outputMatch) {
      shadowLogger.warn('shadow diff', {
        toolName: input.toolName,
        legacyOk: input.legacyResult.success,
        shadowOk: shadowResult.ok,
      });
    }
  } catch (err) {
    shadowLogger.debug('shadow compare threw', {
      toolName: input.toolName,
      err: (err as Error).message,
    });
  }
}
