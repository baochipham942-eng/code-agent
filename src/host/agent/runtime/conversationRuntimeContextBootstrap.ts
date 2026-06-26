// ============================================================================
// ConversationRuntime Context Bootstrap Helpers
// ============================================================================
// 从 ConversationRuntime 抽出的会话起始上下文/记忆注入辅助：桌面派生上下文、活动上下文、
// seed memory 注入、失败轮续接上下文持久化。均为纯结构移动——只读 ctx + 经 contextAssembly
// 注入系统消息，把这两者当参数传入，行为与原私有方法完全一致。

import type { Message } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import {
  bootstrapDesktopTurnContext,
  publishPlanningStateAfterDesktopSync,
} from '../../desktop/desktopContextBridge';
import { buildPackedSeedMemory, buildSeedMemoryBlock } from '../../utils/seedMemoryInjector';
import { countTraceEntries, recordMemoryInjectionTrace } from '../../memory/memoryInjectionTrace';
import {
  recordPackedSeedMemory,
  recordTurnMemoryBlock,
  recordTurnMemoryDisabled,
} from './turnQuality';
import { getCurrentActivityContext } from '../../services/activity/activityContextProvider';
import { formatActivityPromptContext } from '../../services/activity/activityPromptFormatter';
import { getSessionManager } from '../../services';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionTodos, setSessionTodos } from '../../agent/todoParser';
import { getContextWindow } from '../../../shared/constants';
import { estimateTokens } from '../../context/tokenOptimizer';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentLoop');

export async function bootstrapDesktopDerivedContext(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  userMessage?: string,
): Promise<void> {
  const existingTodos = getSessionTodos(ctx.sessionId);
  const persistedTodos = await getSessionManager().getTodos(ctx.sessionId);

  const existingSystemContextTokens =
    estimateTokens(ctx.systemPrompt)
    + estimateTokens(ctx.persistentSystemContext.join('\n\n'))
    + ctx.messages
      .filter((message) => message.role === 'system')
      .reduce((sum, message) => sum + estimateTokens(message.content || ''), 0);
  const contextWindowSize = getContextWindow(ctx.modelConfig.model);
  const contextPressure = existingSystemContextTokens / contextWindowSize;
  const workspaceContextMaxTokens =
    contextPressure >= 0.12 ? 120
      : contextPressure >= 0.08 ? 160
        : 220;
  const workspaceContextMaxItems =
    contextPressure >= 0.12 ? 1
      : contextPressure >= 0.08 ? 2
        : 3;

  const result = await bootstrapDesktopTurnContext({
    sessionId: ctx.sessionId,
    userMessage,
    planningService: ctx.planningService,
    existingTodos,
    persistedTodos,
    workspaceContextBudget: {
      maxTokens: workspaceContextMaxTokens,
      maxItems: workspaceContextMaxItems,
    },
  });

  if (result.advancedTodos) {
    setSessionTodos(ctx.sessionId, result.advancedTodos);
    ctx.onEvent({ type: 'todo_update', data: result.advancedTodos });
  }

  if (result.taskSync.created.length > 0 || result.taskSync.updated.length > 0) {
    ctx.onEvent({
      type: 'task_update',
      data: {
        tasks: result.taskSync.tasks,
        action: 'sync',
        taskIds: [
          ...result.taskSync.created.map((task) => task.id),
          ...result.taskSync.updated.map((task) => task.id),
        ],
        source: 'desktop_activity',
      },
    });
  }

  if (result.planningSyncChanged && ctx.planningService) {
    await publishPlanningStateAfterDesktopSync(ctx.planningService);
  }

  if (result.workspaceContextBlock) {
    contextAssembly.injectSystemMessage(
      `<workspace-activity-context>\n${result.workspaceContextBlock}\n</workspace-activity-context>`
    );
  }

  if (result.recoveredWorkHint) {
    contextAssembly.injectSystemMessage(
      `<recovered-work-orchestration>\n${result.recoveredWorkHint}\n</recovered-work-orchestration>`
    );
  }

  if (result.autoRecovery?.planChanged && ctx.planningService) {
    await publishPlanningStateAfterDesktopSync(ctx.planningService);
  }
}

export async function injectActivityContext(
  contextAssembly: ContextAssembly,
  options: { includeDesktopActivity: boolean },
): Promise<void> {
  try {
    const context = await getCurrentActivityContext();
    const formatted = formatActivityPromptContext(context, {
      mode: 'legacySeparate',
      maxChars: 4_500,
    });

    if (formatted.mode !== 'legacySeparate') return;

    if (formatted.screenMemoryBlock) {
      contextAssembly.injectSystemMessage(`<screen-memory>\n${formatted.screenMemoryBlock}\n</screen-memory>`);
      logger.info('[AgentLoop] Activity screen-memory context injected at session start');
    }

    if (options.includeDesktopActivity && formatted.desktopActivityBlock) {
      contextAssembly.injectSystemMessage(
        `<desktop-activity-context>\n${formatted.desktopActivityBlock}\n</desktop-activity-context>`
      );
      logger.info('[AgentLoop] Activity desktop context injected at session start');
    }
  } catch {
    // Graceful: activity context never blocks a run.
  }
}

export async function injectSeedMemory(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  userMessage: string,
): Promise<void> {
  // Seed Memory Injection
  if (ctx.memoryMode === 'off') {
    recordTurnMemoryDisabled(ctx, 'session_memory_off');
    recordMemoryInjectionTrace({
      blockType: 'seed-memory',
      trigger: 'session_memory_off',
      chars: 0,
      injected: false,
      source: 'session-memory-mode',
      count: 0,
      sessionId: ctx.sessionId,
    });
  } else {
    try {
      let seedMemorySource = 'memory-packer';
      const packedSeedMemory = await buildPackedSeedMemory({
        projectPath: ctx.workingDirectory,
        sessionId: ctx.sessionId,
        query: userMessage,
        excludeEntryIds: ctx.suppressedMemoryEntryIds,
      });
      let seedMemoryBlock = packedSeedMemory?.block ?? null;
      if (!seedMemoryBlock) {
        seedMemorySource = 'database-seed';
        seedMemoryBlock = buildSeedMemoryBlock(ctx.workingDirectory);
      }
      if (seedMemoryBlock) {
        contextAssembly.injectSystemMessage(`<seed-memory>\n${seedMemoryBlock}\n</seed-memory>`);
        recordMemoryInjectionTrace({
          blockType: 'seed-memory',
          trigger: 'session_start',
          chars: seedMemoryBlock.length,
          injected: true,
          source: seedMemorySource,
          count: countTraceEntries(seedMemoryBlock),
          sessionId: ctx.sessionId,
        });
        if (packedSeedMemory) {
          recordPackedSeedMemory(ctx, {
            block: packedSeedMemory.block,
            packed: packedSeedMemory.packed,
            injected: true,
            source: seedMemorySource,
          });
        } else {
          recordTurnMemoryBlock(ctx, {
            blockType: 'seed-memory',
            trigger: 'session_start',
            chars: seedMemoryBlock.length,
            injected: true,
            source: seedMemorySource,
            count: countTraceEntries(seedMemoryBlock),
          });
        }
        logger.info('[AgentLoop] Seed memory injected at session start');
      } else {
        recordMemoryInjectionTrace({
          blockType: 'seed-memory',
          trigger: 'session_start',
          chars: 0,
          injected: false,
          source: seedMemorySource,
          count: 0,
          sessionId: ctx.sessionId,
        });
        recordTurnMemoryBlock(ctx, {
          blockType: 'seed-memory',
          trigger: 'session_start',
          chars: 0,
          injected: false,
          source: seedMemorySource,
          count: 0,
        });
      }
    } catch {
      recordMemoryInjectionTrace({
        blockType: 'seed-memory',
        trigger: 'session_start_error',
        chars: 0,
        injected: false,
        source: 'memory-packer',
        count: 0,
        sessionId: ctx.sessionId,
      });
      recordTurnMemoryBlock(ctx, {
        blockType: 'seed-memory',
        trigger: 'session_start_error',
        chars: 0,
        injected: false,
        source: 'memory-packer',
        count: 0,
      });
      logger.warn('[AgentLoop] Seed memory injection failed, continuing without');
    }
  }
}

export async function persistFailedRunContinuationContext(
  contextAssembly: ContextAssembly,
  userMessage: string,
  iterations: number,
  error: unknown,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const truncatedUserMessage = userMessage.length > 2000
    ? `${userMessage.slice(0, 2000)}\n...[truncated user request]...`
    : userMessage;
  const truncatedError = errorMessage.length > 1200
    ? `${errorMessage.slice(0, 1200)}\n...[truncated runtime error]...`
    : errorMessage;

  const marker: Message = {
    id: generateMessageId(),
    role: 'system',
    content: [
      '<failed-run-continuation-context>',
      '上一轮 agent 运行在完成最终回复前失败。后续如果用户只说“继续”，要沿着这条失败轮恢复，不要回到更早的提问，也不要要求用户重复已经给出的主题。',
      `失败轮用户请求：${truncatedUserMessage}`,
      `失败发生在第 ${iterations} 轮推理后。`,
      `失败错误：${truncatedError}`,
      '</failed-run-continuation-context>',
    ].join('\n'),
    timestamp: Date.now(),
    isMeta: true,
    source: 'system',
  };

  try {
    await contextAssembly.addAndPersistMessage(marker);
  } catch (persistError) {
    logger.warn('[AgentLoop] Failed to persist failed-run continuation context', {
      error: persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
}
