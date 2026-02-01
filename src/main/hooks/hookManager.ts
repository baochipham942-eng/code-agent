// ============================================================================
// Hook Manager - Unified API for the hooks system
// ============================================================================

import type { Message } from '../../shared/types';
import type {
  HookEvent,
  AnyHookContext,
  HookExecutionResult,
  ToolHookContext,
  UserPromptContext,
  StopContext,
  SubagentStartContext,
  PermissionRequestContext,
  SessionContext,
  CompactContext,
} from './events';
import type { HookDefinition, ParsedHookConfig } from './configParser';
import type { MergedHookConfig, MergeStrategy } from './merger';
import type { AICompletionFn } from './promptHook';

import { loadAllHooksConfig } from './configParser';
import { mergeHooks, getHooksForTool, getHooksForEvent } from './merger';
import { executeScript } from './scriptExecutor';
import { executePromptHook } from './promptHook';
import {
  getBuiltinHookExecutor,
  type BuiltinHookContext,
  type BuiltinHookResult,
} from './builtinHookExecutor';
import { createLogger } from '../services/infra/logger';

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
  /** Whether to enable hooks (default: true) */
  enabled?: boolean;
}

export interface HookTriggerResult {
  /** Whether the action should proceed */
  shouldProceed: boolean;
  /** Combined message from all hooks */
  message?: string;
  /** Modified input (if any hook modified it) */
  modifiedInput?: string;
  /** Individual hook results */
  results: HookExecutionResult[];
  /** Total duration of all hook executions */
  totalDuration: number;
}

// ----------------------------------------------------------------------------
// Hook Manager
// ----------------------------------------------------------------------------

export class HookManager {
  private config: HookManagerConfig;
  private hooks: MergedHookConfig[] = [];
  private initialized = false;

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
    sessionId: string
  ): Promise<HookTriggerResult> {
    const context: StopContext = {
      event: 'Stop',
      sessionId,
      timestamp: Date.now(),
      workingDirectory: this.config.workingDirectory,
      response,
    };

    return this.triggerEventHooks('Stop', context);
  }

  // ==========================================================================
  // Phase 2: New hook trigger methods
  // ==========================================================================

  /**
   * Trigger hooks when a subagent starts (Phase 2)
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

  // --------------------------------------------------------------------------
  // Internal Methods
  // --------------------------------------------------------------------------

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
    return this.executeHooks(matchingHooks, context);
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
    return this.executeHooks(matchingHooks, context);
  }

  /**
   * Execute a list of merged hook configs
   *
   * Phase 2: Supports parallel execution when config.parallel is true
   */
  private async executeHooks(
    hookConfigs: MergedHookConfig[],
    context: AnyHookContext
  ): Promise<HookTriggerResult> {
    const results: HookExecutionResult[] = [];
    let shouldProceed = true;
    let message: string | undefined;
    let modifiedInput: string | undefined;
    const startTime = Date.now();

    // Phase 2: 分离并行和串行 hook 配置
    const parallelConfigs = hookConfigs.filter(c => c.parallel);
    const sequentialConfigs = hookConfigs.filter(c => !c.parallel);

    // 先执行并行 hooks
    if (parallelConfigs.length > 0) {
      const parallelResult = await this.executeHooksParallel(parallelConfigs, context);
      results.push(...parallelResult.results);

      if (!parallelResult.shouldProceed) {
        shouldProceed = false;
        message = parallelResult.message;
      }
      if (parallelResult.modifiedInput) {
        modifiedInput = parallelResult.modifiedInput;
      }
      if (parallelResult.message) {
        message = message ? `${message}\n${parallelResult.message}` : parallelResult.message;
      }
    }

    // 如果被阻止，不再执行串行 hooks
    if (!shouldProceed) {
      return {
        shouldProceed,
        message,
        modifiedInput,
        results,
        totalDuration: Date.now() - startTime,
      };
    }

    // 串行执行剩余 hooks
    for (const config of sequentialConfigs) {
      for (const hook of config.hooks) {
        const result = await this.executeHook(hook, context);
        results.push(result);

        // Aggregate results
        if (result.action === 'block') {
          shouldProceed = false;
          message = result.message || message;
          break; // Stop on first block
        }

        if (result.action === 'continue') {
          if (result.message) {
            message = message ? `${message}\n${result.message}` : result.message;
          }
          if (result.modifiedInput) {
            modifiedInput = result.modifiedInput;
          }
        }

        if (result.action === 'error') {
          logger.warn('Hook execution error', { error: result.error });
          // Continue on error (don't block)
        }
      }

      // Stop processing more hooks if blocked
      if (!shouldProceed) break;
    }

    return {
      shouldProceed,
      message,
      modifiedInput,
      results,
      totalDuration: Date.now() - startTime,
    };
  }

  /**
   * Execute hooks in parallel (Phase 2)
   */
  private async executeHooksParallel(
    hookConfigs: MergedHookConfig[],
    context: AnyHookContext
  ): Promise<HookTriggerResult> {
    const startTime = Date.now();

    // 收集所有需要并行执行的 hooks
    const allHooks: Array<{ config: MergedHookConfig; hook: HookDefinition }> = [];
    for (const config of hookConfigs) {
      for (const hook of config.hooks) {
        allHooks.push({ config, hook });
      }
    }

    // 并行执行所有 hooks
    const resultPromises = allHooks.map(({ hook }) =>
      this.executeHook(hook, context)
    );

    const results = await Promise.all(resultPromises);

    // 聚合结果
    let shouldProceed = true;
    let message: string | undefined;
    let modifiedInput: string | undefined;

    for (const result of results) {
      if (result.action === 'block') {
        shouldProceed = false;
        message = result.message || message;
      }

      if (result.action === 'continue' || result.action === 'allow') {
        if (result.message) {
          message = message ? `${message}\n${result.message}` : result.message;
        }
        // 注意：并行执行时，modifiedInput 可能被多个 hook 修改
        // 这里采用最后一个非空值
        if (result.modifiedInput) {
          modifiedInput = result.modifiedInput;
        }
      }

      if (result.action === 'error') {
        logger.warn('Parallel hook execution error', { error: result.error });
      }
    }

    return {
      shouldProceed,
      message,
      modifiedInput,
      results,
      totalDuration: Date.now() - startTime,
    };
  }

  /**
   * Execute a single hook definition
   */
  private async executeHook(
    hook: HookDefinition,
    context: AnyHookContext
  ): Promise<HookExecutionResult> {
    try {
      if (hook.type === 'command' && hook.command) {
        return await executeScript(
          {
            command: hook.command,
            timeout: hook.timeout,
            workingDirectory: this.config.workingDirectory,
          },
          context
        );
      }

      if (hook.type === 'prompt' && hook.prompt && this.config.aiCompletion) {
        return await executePromptHook(
          { prompt: hook.prompt, timeout: hook.timeout },
          context,
          this.config.aiCompletion
        );
      }

      // No AI completion configured for prompt hooks
      if (hook.type === 'prompt' && !this.config.aiCompletion) {
        logger.warn('Prompt hook configured but no AI completion function provided');
        return {
          action: 'allow',
          message: 'Prompt hook skipped - no AI completion configured',
          duration: 0,
        };
      }

      return {
        action: 'error',
        error: 'Invalid hook configuration',
        duration: 0,
      };
    } catch (error: any) {
      return {
        action: 'error',
        error: error.message || 'Hook execution failed',
        duration: 0,
      };
    }
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
