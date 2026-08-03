// ============================================================================
// Hook Manager - Unified API for the hooks system
// ============================================================================

import type { Message } from '../../shared/contract';
import type { HookActivitySource, HookActivityType } from '../../shared/contract/agent';
import type {
  HookEvent,
  AnyHookContext,
  ToolHookContext,
  UserPromptContext,
  StopContext,
  SubagentStartContext,
  PermissionRequestContext,
  SessionContext,
  CompactContext,
  PostExecutionContext,
  TaskCreatedContext,
  TaskCompletedContext,
  PermissionDeniedContext,
  PostCompactContext,
  StopFailureContext,
  RoleWakeContext,
  VoiceCallHookContext,
} from '../protocol/events';
import type { MergedHookConfig, MergeStrategy } from './merger';
import type { AICompletionFn } from './promptHook';

import type { HookDefinition } from './configParser';
import { loadAllHooksConfig } from './configParser';
import { mergeHooks, getHooksForTool, getHooksForEvent } from './merger';
import {
  getBuiltinHookExecutor,
  type BuiltinHookContext,
  type BuiltinHookResult,
} from './builtinHookExecutor';
import {
  executeHooks as runHooks,
  type HookTriggerResult as EngineHookTriggerResult,
} from './hookExecutionEngine';
import { maskSensitiveData } from '../security/sensitiveDetector';
import { createLogger } from '../services/infra/logger';

export type HookTriggerResult = EngineHookTriggerResult;

const logger = createLogger('HookManager');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface HookManagerConfig {
  /** Working directory for loading configs */
  workingDirectory: string;
  /** Merge strategy for hooks from multiple sources */
  mergeStrategy?: MergeStrategy;
  /** AI completion function for prompt hooks */
  aiCompletion?: AICompletionFn;
  /** Notify UI/runtime observers when configured hooks actually run */
  onTrigger?: (entry: TriggerHistoryEntry) => void;
  /** hook 批次开始执行时通知（hook_trigger 的配对信号，会话区据此显示 running 指示） */
  onStart?: (info: HookStartInfo) => void;
  /** Whether to enable hooks (default: true) */
  enabled?: boolean;
}

/**
 * 一批 hook 开始执行的信号。与 hook_trigger（批次完成）配对：会话区收到它显示
 * running 指示，对应 hook_trigger 到达后指示消失。
 */
export interface HookStartInfo {
  timestamp: number;
  event: HookEvent;
  /** 本批要跑的 hook 各自的名字（配置里的 name，没写就退回脚本名）。 */
  names: string[];
  toolName?: string;
  matcher?: string;
}

/**
 * Entry in the trigger history circular buffer
 */
export interface TriggerHistoryEntry {
  timestamp: number;
  event: HookEvent;
  action: 'allow' | 'block';
  durationMs: number;
  hookCount: number;
  modified: boolean;
  sources: HookActivitySource[];
  hookType: HookActivityType;
  /** 触发的 hook 各自的名字（配置里的 name，没写就退回脚本名）。给会话里那行 Hooks 用。 */
  names?: string[];
  errorCount?: number;
  message?: string;
  /**
   * block/modify 的决策原因摘要（message 首个非空行、截 120 字、已脱敏）。
   * 与 message 不同：message 是 hook 的完整输出（渲染层拿不到），reason 是
   * 给会话区上屏用的单行摘要——这是渲染层唯一允许看到的 hook 文本。
   */
  reason?: string;
  toolName?: string;
  matcher?: string;
}

const MAX_TRIGGER_HISTORY = 50;

/** 决策原因摘要上屏长度上限（首行截断）。 */
const HOOK_REASON_MAX_CHARS = 120;

/**
 * 从 trigger 结果里提炼 block/modify 的原因摘要：先对完整文本脱敏、再取首个
 * 非空行、最后截断 120 字。顺序不能反——先截断可能把 secret 拦腰切断，破坏
 * mask 的 token 匹配，让半截密钥上屏。放行且无改写时没有「决策」可言，不出 reason。
 */
function summarizeHookDecisionReason(result: HookTriggerResult): string | undefined {
  if (result.shouldProceed && !result.modifiedInput) return undefined;
  const masked = result.message ? maskSensitiveData(result.message) : undefined;
  const firstLine = masked
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > HOOK_REASON_MAX_CHARS
    ? `${firstLine.slice(0, HOOK_REASON_MAX_CHARS)}…`
    : firstLine;
}

interface HookActivityMetadata {
  sources: HookActivitySource[];
  hookType: HookActivityType;
  names: string[];
  matcher?: string;
  toolName?: string;
}

/**
 * 一个 hook 给人看的名字。优先用配置里显式写的 name——「这个 hook 是干嘛的」只有
 * 配它的人知道，系统不从命令内容去猜。没写就退回可执行文件名，再退回类型。
 */
function hookDisplayName(hook: HookDefinition): string {
  if (hook.name?.trim()) return hook.name.trim();
  const token = hook.command?.trim().split(/\s+/).find((part) => part.includes('/') || part.includes('.'));
  const basename = token?.split('/').pop();
  if (basename) return basename;
  if (hook.type === 'agent' && hook.agent) return hook.agent;
  return hook.type;
}

function matcherLabel(config: MergedHookConfig): string | undefined {
  if (config.mcpServer) {
    return `mcp:${config.mcpServer}`;
  }

  const source = config.matcher?.source;
  if (!source) {
    return undefined;
  }

  return source === '.*' ? '*' : source;
}

function summarizeHookActivity(configs: MergedHookConfig[]): HookActivityMetadata {
  const sourceSet = new Set(configs.flatMap((config) => config.sources));
  const sources = (['global', 'project'] as const).filter((source) => sourceSet.has(source));
  const matchers = Array.from(new Set(configs.map(matcherLabel).filter((value): value is string => Boolean(value))));

  return {
    sources,
    hookType: configs.some((config) => config.hookType === 'decision') ? 'decision' : 'observer',
    names: Array.from(new Set(configs.flatMap((config) => config.hooks.map(hookDisplayName)))),
    ...(matchers.length > 0 ? { matcher: matchers.join(', ') } : {}),
  };
}


// ----------------------------------------------------------------------------
// Hook Manager
// ----------------------------------------------------------------------------

export class HookManager {
  private config: HookManagerConfig;
  private hooks: MergedHookConfig[] = [];
  private initialized = false;
  private executedOnceHooks: Set<string> = new Set();
  private triggerHistory: TriggerHistoryEntry[] = [];

  constructor(config: HookManagerConfig) {
    this.config = {
      mergeStrategy: 'append',
      enabled: true,
      ...config,
    };
  }

  /**
   * Initialize the hook manager by loading configurations
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const configs = await loadAllHooksConfig(this.config.workingDirectory);
      this.hooks = mergeHooks(configs, this.config.mergeStrategy);

      logger.info('HookManager initialized', {
        hookCount: this.hooks.length,
        events: [...new Set(this.hooks.map((h) => h.event))],
      });

      this.initialized = true;
    } catch (error) {
      logger.error('Failed to initialize HookManager', { error });
      this.hooks = [];
      this.initialized = true;
    }
  }

  /**
   * Reload hook configurations
   */
  async reload(): Promise<void> {
    this.initialized = false;
    await this.initialize();
  }

  /**
   * Trigger hooks for a tool use event
   */
  async triggerPreToolUse(
    toolName: string,
    toolInput: string,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: ToolHookContext = {
      event: 'PreToolUse',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      toolName,
      toolInput,
    };

    return this.triggerToolHooks('PreToolUse', toolName, context);
  }

  /**
   * Trigger hooks after successful tool use
   */
  async triggerPostToolUse(
    toolName: string,
    toolInput: string,
    toolOutput: string,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: ToolHookContext = {
      event: 'PostToolUse',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      toolName,
      toolInput,
      toolOutput,
    };

    return this.triggerToolHooks('PostToolUse', toolName, context);
  }

  /**
   * Trigger hooks after tool use failure
   */
  async triggerPostToolUseFailure(
    toolName: string,
    toolInput: string,
    errorMessage: string,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: ToolHookContext = {
      event: 'PostToolUseFailure',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      toolName,
      toolInput,
      errorMessage,
    };

    return this.triggerToolHooks('PostToolUseFailure', toolName, context);
  }

  /**
   * Trigger hooks for user prompt submission
   */
  async triggerUserPromptSubmit(
    prompt: string,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: UserPromptContext = {
      event: 'UserPromptSubmit',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      prompt,
    };

    return this.triggerEventHooks('UserPromptSubmit', context);
  }

  /**
   * Trigger hooks when agent stops
   */
  async triggerStop(
    response: string | undefined,
    sessionId: string,
    stopHookActive = false
  ): Promise<HookTriggerResult> {
    const context: StopContext = {
      event: 'Stop',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      response,
      stopHookActive,
    };

    return this.triggerEventHooks('Stop', context);
  }

  // ==========================================================================
  // Phase 2: New hook trigger methods
  // ==========================================================================

  /**
   * Trigger hooks when a subagent starts (Phase 2)
   * @experimental API may change between minor versions
   */
  async triggerSubagentStart(
    subagentType: string,
    subagentId: string,
    taskPrompt: string,
    sessionId: string,
    parentToolUseId?: string
  ): Promise<HookTriggerResult> {
    const context: SubagentStartContext = {
      event: 'SubagentStart',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      subagentType,
      subagentId,
      taskPrompt,
      parentToolUseId,
    };

    return this.triggerEventHooks('SubagentStart', context);
  }

  /**
   * Trigger hooks when a permission is requested (Phase 2)
   * @experimental API may change between minor versions
   */
  async triggerPermissionRequest(
    permissionType: 'read' | 'write' | 'execute' | 'network' | 'dangerous',
    resource: string,
    toolName: string,
    sessionId: string,
    reason?: string
  ): Promise<HookTriggerResult> {
    const context: PermissionRequestContext = {
      event: 'PermissionRequest',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      permissionType,
      resource,
      toolName,
      reason,
    };

    return this.triggerEventHooks('PermissionRequest', context);
  }

  /**
   * Trigger hooks for session start
   */
  async triggerSessionStart(
    sessionId: string
  ): Promise<HookTriggerResult & { injectedContext?: string }> {
    const context: SessionContext = {
      event: 'SessionStart',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
    };

    // 执行用户配置的钩子
    const userResult = await this.triggerEventHooks('SessionStart', context);

    // 执行内置钩子
    const builtinContext: BuiltinHookContext = {
      sessionId,
      workingDirectory: this.config.workingDirectory,
    };

    const builtinResults = await getBuiltinHookExecutor().executeForEvent(
      'SessionStart',
      builtinContext
    );

    // 合并结果，提取注入的上下文
    const merged = this.mergeResults(userResult, builtinResults);
    const injectedContext = builtinResults
      .filter((r): r is BuiltinHookResult => 'injectedContext' in r && !!r.injectedContext)
      .map((r) => r.injectedContext)
      .join('\n\n');

    return {
      ...merged,
      injectedContext: injectedContext || undefined,
    };
  }

  /**
   * Trigger hooks for session end
   */
  async triggerSessionEnd(
    sessionId: string,
    messages?: Message[],
    toolExecutions?: Array<{
      name: string;
      input: unknown;
      output?: unknown;
      success: boolean;
      timestamp: number;
    }>
  ): Promise<HookTriggerResult> {
    const context: SessionContext = {
      event: 'SessionEnd',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
    };

    // 执行用户配置的钩子
    const userResult = await this.triggerEventHooks('SessionEnd', context);

    // 执行内置钩子
    const builtinContext: BuiltinHookContext = {
      sessionId,
      workingDirectory: this.config.workingDirectory,
      messages,
      toolExecutions,
    };

    const builtinResults = await getBuiltinHookExecutor().executeForEvent(
      'SessionEnd',
      builtinContext
    );

    // 合并结果
    return this.mergeResults(userResult, builtinResults);
  }

  /**
   * Trigger hooks before context compaction
   */
  async triggerPreCompact(
    sessionId: string,
    messages: Message[],
    tokenCount: number,
    targetTokenCount: number
  ): Promise<HookTriggerResult & { preservedContext?: string }> {
    const context: CompactContext = {
      event: 'PreCompact',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      tokenCount,
      targetTokenCount,
    };

    // 执行用户配置的钩子
    const userResult = await this.triggerEventHooks('PreCompact', context);

    // 执行内置钩子
    const builtinContext: BuiltinHookContext = {
      sessionId,
      workingDirectory: this.config.workingDirectory,
      messages,
      tokenCount,
      targetTokenCount,
    };

    const builtinResults = await getBuiltinHookExecutor().executeForEvent(
      'PreCompact',
      builtinContext
    );

    // 合并结果，提取保留的上下文
    const merged = this.mergeResults(userResult, builtinResults);
    const preservedContext = builtinResults
      .filter((r): r is BuiltinHookResult => 'injectedContext' in r && !!r.injectedContext)
      .map((r) => r.injectedContext)
      .join('\n\n');

    return {
      ...merged,
      preservedContext: preservedContext || undefined,
    };
  }

  /**
   * Trigger hooks after each agent turn completes (async, non-blocking)
   * Used for GC scans, codebase health checks, etc.
   */
  async triggerPostExecution(
    sessionId: string,
    turnCount: number,
    toolsUsed: string[],
    modifiedFiles: string[],
  ): Promise<HookTriggerResult> {
    const context: PostExecutionContext = {
      event: 'PostExecution',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      turnCount,
      toolsUsed,
      modifiedFiles,
    };

    return this.triggerEventHooks('PostExecution', context);
  }

  /**
   * Trigger hooks when a subagent stops/completes (Phase 2)
   * @experimental API may change between minor versions
   */
  async triggerSubagentStop(
    subagentType: string,
    response: string | undefined,
    sessionId: string,
    agentId?: string
  ): Promise<HookTriggerResult> {
    const context: StopContext = {
      event: 'SubagentStop',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      response,
      subagentType,
      // GAP-012: sessionId + agentId 构成 swarm trace 查询入口
      agentId,
    };

    return this.triggerEventHooks('SubagentStop', context);
  }

  // ==========================================================================
  // Phase 3: Task lifecycle + environmental event hooks
  // ==========================================================================

  /**
   * Trigger hooks when an agent task is created
   * Wired via AgentTask.onHook callback in subagentExecutor
   */
  async triggerTaskCreated(
    taskId: string,
    agentType: string,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: TaskCreatedContext = {
      event: 'TaskCreated',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      taskId,
      agentType,
    };

    return this.triggerEventHooks('TaskCreated', context);
  }

  /**
   * Trigger hooks when an agent task completes or fails
   * Wired via AgentTask.onHook callback in subagentExecutor
   */
  async triggerTaskCompleted(
    taskId: string,
    agentType: string,
    success: boolean,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: TaskCompletedContext = {
      event: 'TaskCompleted',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      taskId,
      agentType,
      success,
    };

    return this.triggerEventHooks('TaskCompleted', context);
  }

  /**
   * Trigger hooks when a tool permission is denied (observer-only)
   * @experimental
   */
  async triggerPermissionDenied(
    toolName: string,
    reason: string,
    deniedBy: 'user' | 'hook' | 'policy' | 'classifier',
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: PermissionDeniedContext = {
      event: 'PermissionDenied',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      toolName,
      reason,
      deniedBy,
    };

    return this.triggerEventHooks('PermissionDenied', context);
  }

  /**
   * Trigger hooks after context compaction completes (observer-only)
   * @experimental
   */
  async triggerPostCompact(
    savedTokens: number,
    strategy: string,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: PostCompactContext = {
      event: 'PostCompact',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      savedTokens,
      strategy,
    };

    return this.triggerEventHooks('PostCompact', context);
  }

  /**
   * Trigger hooks when the agent stops due to an error (observer-only)
   * @experimental
   */
  async triggerStopFailure(
    error: string,
    phase: string,
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: StopFailureContext = {
      event: 'StopFailure',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      error,
      phase,
    };

    return this.triggerEventHooks('StopFailure', context);
  }

  /**
   * Trigger hooks when a persistent role wakes up proactively (observer-only)
   * 角色主动性醒来事件（内部文档 §2.3）
   * @experimental API may change between minor versions
   */
  async triggerRoleWake(params: {
    roleId: string;
    trigger: 'cadence' | 'event';
    decision: 'advance' | 'report' | 'suggest' | 'silence';
    sessionId: string;
  }): Promise<HookTriggerResult> {
    const context: RoleWakeContext = {
      event: 'RoleWake',
      sessionId: params.sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      roleId: params.roleId,
      trigger: params.trigger,
      decision: params.decision,
    };

    return this.triggerEventHooks('RoleWake', context);
  }

  /**
   * 实时通话生命周期（observer-only）。三个事件同一通电话共用 voiceCallId，
   * 断线重连不换 id、也不重复发 started——订阅方靠这一点区分「真结束」和「网络抖动」。
   * @experimental API may change between minor versions
   */
  async triggerVoiceCall(
    event: 'VoiceCallStarted' | 'VoiceCallPaused' | 'VoiceCallEnded',
    params: {
      voiceCallId: string;
      sessionId: string;
      durationSec: number;
      workItemCount?: number;
      reason?: string;
    }
  ): Promise<HookTriggerResult> {
    const context: VoiceCallHookContext = {
      event,
      sessionId: params.sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      voiceCallId: params.voiceCallId,
      durationSec: params.durationSec,
      ...(params.workItemCount !== undefined ? { workItemCount: params.workItemCount } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    };

    return this.triggerEventHooks(event, context);
  }

  // ==========================================================================
  // Trigger History
  // ==========================================================================

  /**
   * Get the trigger history (most recent entries, max 50)
   */
  getTriggerHistory(): readonly TriggerHistoryEntry[] {
    return this.triggerHistory;
  }

  /**
   * Record a trigger in the history buffer
   */
  private recordTrigger(
    event: HookEvent,
    result: HookTriggerResult,
    metadata?: HookActivityMetadata,
  ): void {
    const errorCount = result.results.filter((entry) => entry.action === 'error' || entry.error).length;
    const reason = summarizeHookDecisionReason(result);
    const entry: TriggerHistoryEntry = {
      timestamp: Date.now(),
      event,
      action: result.shouldProceed ? 'allow' : 'block',
      durationMs: result.totalDuration,
      hookCount: result.results.length,
      modified: !!result.modifiedInput,
      sources: metadata?.sources || [],
      hookType: metadata?.hookType || 'observer',
      ...(metadata?.names?.length ? { names: metadata.names } : {}),
      ...(errorCount > 0 ? { errorCount } : {}),
      // GAP-015: trigger history 是观测日志（UI/导出可见），message 必须脱敏；
      // HookTriggerResult.message 本身（注入上下文用）不脱敏，保持功能不变
      ...(result.message ? { message: maskSensitiveData(result.message) } : {}),
      ...(reason ? { reason } : {}),
      ...(metadata?.toolName ? { toolName: metadata.toolName } : {}),
      ...(metadata?.matcher ? { matcher: metadata.matcher } : {}),
    };

    this.triggerHistory.push(entry);
    if (this.triggerHistory.length > MAX_TRIGGER_HISTORY) {
      this.triggerHistory.shift();
    }

    if (entry.hookCount > 0 || entry.action === 'block' || entry.modified || entry.message || entry.errorCount) {
      try {
        this.config.onTrigger?.(entry);
      } catch (error) {
        logger.warn('Hook trigger observer failed', { error: (error as Error).message });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Internal Methods
  // --------------------------------------------------------------------------

  /**
   * hook 批次开跑信号：有匹配 hook 才发，发的批次随后必有 recordTrigger（runHooks
   * 把执行异常也收成 result），会话区的 running 指示一定能等到配对的 hook_trigger。
   */
  private emitHookStart(event: HookEvent, metadata: HookActivityMetadata): void {
    if (!this.config.onStart || metadata.names.length === 0) return;
    try {
      this.config.onStart({
        timestamp: Date.now(),
        event,
        names: metadata.names,
        ...(metadata.toolName ? { toolName: metadata.toolName } : {}),
        ...(metadata.matcher ? { matcher: metadata.matcher } : {}),
      });
    } catch (error) {
      logger.warn('Hook start observer failed', { error: (error as Error).message });
    }
  }

  /**
   * Trigger hooks for tool-related events
   */
  private async triggerToolHooks(
    event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
    toolName: string,
    context: ToolHookContext
  ): Promise<HookTriggerResult> {
    if (!this.config.enabled || !this.initialized) {
      return this.createAllowResult();
    }

    const matchingHooks = getHooksForTool(this.hooks, event, toolName);
    const metadata = { ...summarizeHookActivity(matchingHooks), toolName };
    this.emitHookStart(event, metadata);
    const result = await runHooks(matchingHooks, context, this.engineEnv());
    this.recordTrigger(event, result, metadata);
    return result;
  }

  /**
   * Trigger hooks for non-tool events
   */
  private async triggerEventHooks(
    event: HookEvent,
    context: AnyHookContext
  ): Promise<HookTriggerResult> {
    if (!this.config.enabled || !this.initialized) {
      return this.createAllowResult();
    }

    const matchingHooks = getHooksForEvent(this.hooks, event);
    const metadata = summarizeHookActivity(matchingHooks);
    this.emitHookStart(event, metadata);
    const result = await runHooks(matchingHooks, context, this.engineEnv());
    this.recordTrigger(event, result, metadata);
    return result;
  }

  private engineEnv() {
    return {
      workingDirectory: this.config.workingDirectory,
      aiCompletion: this.config.aiCompletion,
      executedOnceHooks: this.executedOnceHooks,
    };
  }

  /**
   * Create a default "allow" result
   */
  private createAllowResult(): HookTriggerResult {
    return {
      shouldProceed: true,
      results: [],
      totalDuration: 0,
    };
  }

  /**
   * Merge user hook results with builtin hook results
   */
  private mergeResults(
    userResult: HookTriggerResult,
    builtinResults: BuiltinHookResult[]
  ): HookTriggerResult {
    const allResults = [...userResult.results, ...builtinResults];
    const builtinDuration = builtinResults.reduce((sum, r) => sum + r.duration, 0);

    // 如果用户钩子或内置钩子任一阻止，则阻止
    const anyBlock = builtinResults.some((r) => r.action === 'block');

    // 合并消息
    const builtinMessages = builtinResults
      .filter((r) => r.message)
      .map((r) => r.message)
      .join('\n');

    const combinedMessage = [userResult.message, builtinMessages]
      .filter(Boolean)
      .join('\n');

    return {
      shouldProceed: userResult.shouldProceed && !anyBlock,
      message: combinedMessage || undefined,
      modifiedInput: userResult.modifiedInput,
      results: allResults,
      totalDuration: userResult.totalDuration + builtinDuration,
    };
  }

  /**
   * Check if any hooks are configured for an event
   */
  hasHooksFor(event: HookEvent): boolean {
    return this.hooks.some((h) => h.event === event);
  }

  /**
   * Get count of hooks by event
   */
  getHookStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const hook of this.hooks) {
      stats[hook.event] = (stats[hook.event] || 0) + hook.hooks.length;
    }
    return stats;
  }
}

/**
 * Create a hook manager instance
 */
export function createHookManager(config: HookManagerConfig): HookManager {
  return new HookManager(config);
}
