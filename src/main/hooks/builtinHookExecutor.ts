// ============================================================================
// Built-in Hook Executor - 执行内置钩子
// ============================================================================

import type { Message } from '../../shared/types';
import type {
  HookEvent,
  HookExecutionResult,
  SessionContext,
  CompactContext,
} from './events';
import type { HookTemplate } from './templates/hookTemplates';
import { BUILT_IN_TEMPLATES, getTemplateById } from './templates/hookTemplates';
import {
  sessionStartMemoryHook,
  sessionEndMemoryHook,
  type MemoryServiceInterface,
} from './builtins/memoryHooks';
import {
  preCompactContextHook,
  type CompactionStrategy,
} from './builtins/contextHooks';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('BuiltinHookExecutor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 内置钩子配置
 */
export interface BuiltinHookConfig {
  /** 模板 ID */
  templateId: string;
  /** 是否启用 */
  enabled: boolean;
  /** 配置选项 */
  options?: Record<string, unknown>;
}

/**
 * 内置钩子执行上下文
 */
export interface BuiltinHookContext {
  /** 会话 ID */
  sessionId: string;
  /** 工作目录 */
  workingDirectory: string;
  /** 消息历史 */
  messages?: Message[];
  /** 工具执行记录 */
  toolExecutions?: Array<{
    name: string;
    input: unknown;
    output?: unknown;
    success: boolean;
    timestamp: number;
  }>;
  /** Token 信息（用于 PreCompact）*/
  tokenCount?: number;
  /** 目标 Token 数（用于 PreCompact）*/
  targetTokenCount?: number;
}

/**
 * 内置钩子执行结果
 */
export interface BuiltinHookResult extends HookExecutionResult {
  /** 注入的额外上下文 */
  injectedContext?: string;
  /** 保留的上下文数据 */
  preservedData?: unknown;
  /** 学习成果数量 */
  learnedCount?: number;
}

// ----------------------------------------------------------------------------
// Built-in Hook Executor
// ----------------------------------------------------------------------------

/**
 * 内置钩子执行器
 *
 * 负责执行内置的钩子模板，如记忆注入、记忆持久化、上下文保留等。
 */
export class BuiltinHookExecutor {
  private enabledHooks: Map<string, BuiltinHookConfig> = new Map();

  constructor() {
    // 默认启用所有带 enabled: true 的模板
    for (const template of BUILT_IN_TEMPLATES) {
      if (template.enabled) {
        this.enabledHooks.set(template.id, {
          templateId: template.id,
          enabled: true,
          options: this.getDefaultOptions(template),
        });
      }
    }
  }

  /**
   * 启用/禁用钩子
   */
  setHookEnabled(templateId: string, enabled: boolean): void {
    const template = getTemplateById(templateId);
    if (!template) {
      logger.warn(`Template not found: ${templateId}`);
      return;
    }

    const existing = this.enabledHooks.get(templateId);
    if (existing) {
      existing.enabled = enabled;
    } else if (enabled) {
      this.enabledHooks.set(templateId, {
        templateId,
        enabled: true,
        options: this.getDefaultOptions(template),
      });
    }

    logger.info(`Hook ${templateId} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 更新钩子配置
   */
  updateHookConfig(templateId: string, options: Record<string, unknown>): void {
    const config = this.enabledHooks.get(templateId);
    if (config) {
      config.options = { ...config.options, ...options };
      logger.debug(`Updated config for ${templateId}`, { options });
    }
  }

  /**
   * 执行事件对应的内置钩子
   */
  async executeForEvent(
    event: HookEvent,
    context: BuiltinHookContext
  ): Promise<BuiltinHookResult[]> {
    const results: BuiltinHookResult[] = [];

    // 获取该事件类型的所有启用钩子
    const enabledForEvent = Array.from(this.enabledHooks.values()).filter(
      (config) => {
        const template = getTemplateById(config.templateId);
        return template && template.event === event && config.enabled;
      }
    );

    for (const config of enabledForEvent) {
      try {
        const result = await this.executeHook(config, event, context);
        results.push(result);
      } catch (error) {
        logger.error(`Failed to execute builtin hook ${config.templateId}`, { error });
        results.push({
          action: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: 0,
        });
      }
    }

    return results;
  }

  /**
   * 执行单个钩子
   */
  private async executeHook(
    config: BuiltinHookConfig,
    event: HookEvent,
    context: BuiltinHookContext
  ): Promise<BuiltinHookResult> {
    const startTime = Date.now();

    switch (config.templateId) {
      case 'session-start-memory-inject':
        return this.executeSessionStartMemoryInject(config, context, startTime);

      case 'session-end-memory-persist':
        return this.executeSessionEndMemoryPersist(config, context, startTime);

      case 'pre-compact-context-preserve':
        return this.executePreCompactContextPreserve(config, context, startTime);

      case 'dangerous-command-warning':
        // 这个钩子由用户配置的脚本处理，内置版本只是模板
        return {
          action: 'allow',
          message: 'Dangerous command warning is handled by script hooks',
          duration: Date.now() - startTime,
        };

      case 'tool-execution-log':
        // 日志记录由其他系统处理
        return {
          action: 'continue',
          message: 'Tool execution logging handled',
          duration: Date.now() - startTime,
        };

      case 'auto-commit-reminder':
        // 这个钩子需要检查 git 状态
        return this.executeAutoCommitReminder(config, context, startTime);

      default:
        return {
          action: 'allow',
          message: `No handler for template: ${config.templateId}`,
          duration: Date.now() - startTime,
        };
    }
  }

  /**
   * 执行会话开始记忆注入
   */
  private async executeSessionStartMemoryInject(
    config: BuiltinHookConfig,
    context: BuiltinHookContext,
    startTime: number
  ): Promise<BuiltinHookResult> {
    // 获取 Memory 服务适配器（如果可用）
    const memoryService = await this.getMemoryServiceAdapter();

    const sessionContext: SessionContext = {
      event: 'SessionStart',
      sessionId: context.sessionId,
      workingDirectory: context.workingDirectory,
      timestamp: Date.now(),
    };

    const hookResult = await sessionStartMemoryHook(sessionContext, memoryService);

    return {
      action: hookResult.action === 'continue' ? 'continue' : 'allow',
      message: hookResult.message,
      injectedContext: hookResult.message,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 执行会话结束记忆持久化
   */
  private async executeSessionEndMemoryPersist(
    config: BuiltinHookConfig,
    context: BuiltinHookContext,
    startTime: number
  ): Promise<BuiltinHookResult> {
    if (!context.messages) {
      return {
        action: 'allow',
        message: 'No messages to extract learnings from',
        duration: Date.now() - startTime,
      };
    }

    // 获取 Memory 服务适配器（如果可用）
    const memoryService = await this.getMemoryServiceAdapter();

    const sessionContext: SessionContext = {
      event: 'SessionEnd',
      sessionId: context.sessionId,
      workingDirectory: context.workingDirectory,
      timestamp: Date.now(),
    };

    const hookResult = await sessionEndMemoryHook(sessionContext, memoryService, context.messages);

    return {
      action: hookResult.action === 'continue' ? 'continue' : 'allow',
      message: hookResult.message,
      learnedCount: 0, // 从 hookResult.message 中无法直接获取数量
      duration: Date.now() - startTime,
    };
  }

  /**
   * 获取 Memory 服务适配器
   */
  private async getMemoryServiceAdapter(): Promise<MemoryServiceInterface | null> {
    try {
      // 尝试动态导入 memory 服务
      const memoryModule = await import('../memory/memoryService');
      if (memoryModule.getMemoryService) {
        const service = memoryModule.getMemoryService();
        if (service) {
          return {
            add: async (memory) => {
              // 使用 addKnowledge 方法
              await service.addKnowledge(memory.content, memory.type);
            },
            search: async (query, options) => {
              // 使用 searchKnowledgeAsync 方法
              const results = await service.searchKnowledgeAsync(query, {
                topK: options?.limit || 5,
              });
              // EnhancedSearchResult extends SearchResult which has document.content
              return results.map((r) => ({
                content: r.document?.content || '',
                type: String(r.document?.metadata?.type || 'knowledge'),
                confidence: r.score || 0.5,
              }));
            },
          };
        }
      }
    } catch (e) {
      logger.debug('Memory service not available');
    }
    return null;
  }

  /**
   * 执行压缩前上下文保留
   */
  private async executePreCompactContextPreserve(
    config: BuiltinHookConfig,
    context: BuiltinHookContext,
    startTime: number
  ): Promise<BuiltinHookResult> {
    if (!context.messages) {
      return {
        action: 'allow',
        message: 'No messages to preserve context from',
        duration: Date.now() - startTime,
      };
    }

    const compactContext: CompactContext = {
      event: 'PreCompact',
      sessionId: context.sessionId,
      workingDirectory: context.workingDirectory,
      timestamp: Date.now(),
      tokenCount: context.tokenCount || 0,
      targetTokenCount: context.targetTokenCount || 0,
    };

    const strategy = (config.options?.strategy as string) || 'balanced';
    const hookResult = await preCompactContextHook(
      compactContext,
      context.messages,
      strategy as CompactionStrategy
    );

    return {
      action: hookResult.action === 'continue' ? 'continue' : 'allow',
      message: hookResult.message,
      injectedContext: hookResult.message,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 执行自动提交提醒
   */
  private async executeAutoCommitReminder(
    config: BuiltinHookConfig,
    context: BuiltinHookContext,
    startTime: number
  ): Promise<BuiltinHookResult> {
    // TODO: 实现 git 状态检查
    // 这需要调用 bash 工具检查 git status
    const minChanges = (config.options?.minChanges as number) || 3;

    return {
      action: 'allow',
      message: `Auto-commit reminder configured (min changes: ${minChanges})`,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 获取模板的默认配置
   */
  private getDefaultOptions(template: HookTemplate): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    if (template.options) {
      for (const opt of template.options) {
        options[opt.id] = opt.defaultValue;
      }
    }
    return options;
  }

  /**
   * 获取所有启用的钩子
   */
  getEnabledHooks(): BuiltinHookConfig[] {
    return Array.from(this.enabledHooks.values()).filter((c) => c.enabled);
  }

  /**
   * 检查某事件是否有启用的内置钩子
   */
  hasEnabledHooksFor(event: HookEvent): boolean {
    return Array.from(this.enabledHooks.values()).some((config) => {
      const template = getTemplateById(config.templateId);
      return template && template.event === event && config.enabled;
    });
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let executorInstance: BuiltinHookExecutor | null = null;

/**
 * 获取 BuiltinHookExecutor 单例
 */
export function getBuiltinHookExecutor(): BuiltinHookExecutor {
  if (!executorInstance) {
    executorInstance = new BuiltinHookExecutor();
  }
  return executorInstance;
}

/**
 * 创建新的 BuiltinHookExecutor 实例
 */
export function createBuiltinHookExecutor(): BuiltinHookExecutor {
  return new BuiltinHookExecutor();
}
