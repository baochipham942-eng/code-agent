// ============================================================================
// hookExecutionEngine — Hook 执行引擎，从 HookManager god class 抽出
// 职责：单 hook 执行（含 once/async/conditional）+ 多 hook 编排（串行/并行）
// 不持有 manager state，所有 state 通过 HookExecutionEnv 注入
// ============================================================================

import type {
  AnyHookContext,
  HookExecutionResult,
  ToolHookContext,
} from '../protocol/events';
import type { HookDefinition } from './configParser';
import type { MergedHookConfig } from './merger';
import type { AICompletionFn } from './promptHook';

import { matchesCondition } from './configParser';
import { executeScript } from './scriptExecutor';
import { executePromptHook } from './promptHook';
import { executeAgentHook } from './agentHook';
import { executeHttpHook } from './httpHookExecutor';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('HookExecutionEngine');

export interface HookTriggerResult {
  shouldProceed: boolean;
  message?: string;
  modifiedInput?: string;
  results: HookExecutionResult[];
  totalDuration: number;
}

/**
 * Engine 执行环境：把 manager 上的 state 显式传入，避免引擎依赖 class。
 */
export interface HookExecutionEnv {
  workingDirectory: string;
  aiCompletion?: AICompletionFn;
  /** 引用——manager 的 once-hook tracker，引擎读写共享 Set */
  executedOnceHooks: Set<string>;
}

/**
 * 为 hook 生成唯一 ID（用于 once-tracking）
 */
export function getHookId(hook: HookDefinition): string {
  if (hook.type === 'command') return `command:${hook.command}`;
  if (hook.type === 'prompt') return `prompt:${hook.prompt}`;
  if (hook.type === 'agent') return `agent:${hook.agent}:${hook.agentPrompt || ''}`;
  if (hook.type === 'http') return `http:${hook.url}`;
  return `unknown:${JSON.stringify(hook)}`;
}

/**
 * 执行单个 hook 定义，处理 conditional / once / async 三个修饰符。
 */
export async function executeHook(
  hook: HookDefinition,
  context: AnyHookContext,
  env: HookExecutionEnv,
): Promise<HookExecutionResult> {
  if (hook.if && 'toolName' in context) {
    const toolInput = 'toolInput' in context ? String(context.toolInput) : '';
    if (!matchesCondition(hook.if, (context as ToolHookContext).toolName, toolInput)) {
      return { action: 'allow', message: 'Condition not met, skipping', duration: 0 };
    }
  }

  if (hook.once) {
    const hookId = getHookId(hook);
    if (env.executedOnceHooks.has(hookId)) {
      return { action: 'allow', message: 'Once-hook already executed, skipping', duration: 0 };
    }
    env.executedOnceHooks.add(hookId);
  }

  if (hook.async) {
    executeHookCore(hook, context, env).catch((error) => {
      logger.warn('Async hook execution failed', { error: (error as Error).message });
    });
    return { action: 'allow', message: 'Async hook fired', duration: 0 };
  }

  return executeHookCore(hook, context, env);
}

/**
 * 单 hook 实际执行：command / prompt / agent / http 分发
 */
export async function executeHookCore(
  hook: HookDefinition,
  context: AnyHookContext,
  env: HookExecutionEnv,
): Promise<HookExecutionResult> {
  try {
    if (hook.type === 'command' && hook.command) {
      return await executeScript(
        {
          command: hook.command,
          timeout: hook.timeout,
          workingDirectory: env.workingDirectory,
        },
        context,
      );
    }

    if (hook.type === 'prompt' && hook.prompt && env.aiCompletion) {
      return await executePromptHook(
        { prompt: hook.prompt, timeout: hook.timeout },
        context,
        env.aiCompletion,
      );
    }

    if (hook.type === 'prompt' && !env.aiCompletion) {
      logger.warn('Prompt hook configured but no AI completion function provided');
      return {
        action: 'allow',
        message: 'Prompt hook skipped - no AI completion configured',
        duration: 0,
      };
    }

    if (hook.type === 'agent' && hook.agent) {
      const startTime = Date.now();
      const result = await executeAgentHook(
        { agent: hook.agent, agentPrompt: hook.agentPrompt, context },
        env.aiCompletion,
      );
      return {
        action: result.success ? 'continue' : 'error',
        message: result.output,
        duration: Date.now() - startTime,
      };
    }

    if (hook.type === 'http') {
      if (!hook.url) {
        return { action: 'error', error: 'HTTP hook missing url', duration: 0 };
      }
      return executeHttpHook(
        { url: hook.url, headers: hook.headers, timeout: hook.timeout, allowedEnvVars: hook.allowedEnvVars },
        context,
      );
    }

    return {
      action: 'error',
      error: 'Invalid hook configuration',
      duration: 0,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action: 'error',
      error: message || 'Hook execution failed',
      duration: 0,
    };
  }
}

/**
 * 并行执行 hooks 并聚合结果。Observer hook 的 block/modify 信号被忽略，仅收集消息。
 */
async function executeHooksParallel(
  hookConfigs: MergedHookConfig[],
  context: AnyHookContext,
  env: HookExecutionEnv,
): Promise<HookTriggerResult> {
  const startTime = Date.now();

  const allHooks: Array<{ config: MergedHookConfig; hook: HookDefinition }> = [];
  for (const config of hookConfigs) {
    for (const hook of config.hooks) {
      allHooks.push({ config, hook });
    }
  }

  const resultPromises = allHooks.map(({ hook }) => executeHook(hook, context, env));
  const results = await Promise.all(resultPromises);

  let shouldProceed = true;
  let message: string | undefined;
  let modifiedInput: string | undefined;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const isObserver = allHooks[i].config.hookType === 'observer';

    if (isObserver) {
      if (result.action === 'block') {
        logger.info('Parallel observer hook tried to block — ignored', { event: context.event });
      }
      if (result.modifiedInput) {
        logger.info('Parallel observer hook tried to modify input — ignored', { event: context.event });
      }
      if (result.message && result.action !== 'error') {
        message = message ? `${message}\n${result.message}` : result.message;
      }
      continue;
    }

    if (result.action === 'block') {
      shouldProceed = false;
      message = result.message || message;
    }

    if (result.action === 'continue' || result.action === 'allow') {
      if (result.message) {
        message = message ? `${message}\n${result.message}` : result.message;
      }
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
 * 执行多个 hook configs：先并行（标记 parallel 的）后串行。
 * 任一 decision hook block 后立即停止串行后续 hooks。
 */
export async function executeHooks(
  hookConfigs: MergedHookConfig[],
  context: AnyHookContext,
  env: HookExecutionEnv,
): Promise<HookTriggerResult> {
  const results: HookExecutionResult[] = [];
  let shouldProceed = true;
  let message: string | undefined;
  let modifiedInput: string | undefined;
  const startTime = Date.now();

  const parallelConfigs = hookConfigs.filter(c => c.parallel);
  const sequentialConfigs = hookConfigs.filter(c => !c.parallel);

  if (parallelConfigs.length > 0) {
    const parallelResult = await executeHooksParallel(parallelConfigs, context, env);
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

  if (!shouldProceed) {
    return {
      shouldProceed,
      message,
      modifiedInput,
      results,
      totalDuration: Date.now() - startTime,
    };
  }

  for (const config of sequentialConfigs) {
    const isObserver = config.hookType === 'observer';

    for (const hook of config.hooks) {
      const result = await executeHook(hook, context, env);
      results.push(result);

      if (isObserver) {
        if (result.action === 'block') {
          logger.info('Observer hook tried to block — ignored', { event: context.event });
        }
        if (result.modifiedInput) {
          logger.info('Observer hook tried to modify input — ignored', { event: context.event });
        }
        if (result.message && result.action !== 'error') {
          message = message ? `${message}\n${result.message}` : result.message;
        }
        continue;
      }

      if (result.action === 'block') {
        shouldProceed = false;
        message = result.message || message;
        break;
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
      }
    }

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
