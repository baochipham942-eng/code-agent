// ContextAssembly - Persistent system context stack and context event ledger.
import type { Message } from '../../../../shared/contract';
import type {
  ContextEventRecord,
  ContextInjectionSource,
} from '../../../context/contextEventLedger';
import { getSessionManager } from '../../../services';
import type { SystemEventMessageMetadata } from '../../../../shared/contract/systemEventRegistry';
import { estimateTokens } from '../../../context/tokenOptimizer';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import type { ContextAssemblyCtx } from './shared';
import { persistRuntimeState } from '../runtimeStatePersistence';
import { attachMessageCorrelation } from '../turnQuality';
import {
  logger,
  MAX_PERSISTENT_SYSTEM_CONTEXT_TOKENS,
  MAX_PERSISTENT_SYSTEM_CONTEXT_ITEMS,
  MAX_PERSISTENT_SYSTEM_CONTEXT_ITEM_TOKENS,
  normalizePersistentSystemContextKey,
} from './shared';

const CONTEXT_ASSEMBLY_PERSISTED_MESSAGE = Symbol.for('code-agent.contextAssembly.persistedMessage');
const CONTEXT_INJECTION_METADATA = Symbol.for('code-agent.contextAssembly.injectionMetadata');
type ContextAssemblyPersistedMessage = Message & {
  [CONTEXT_ASSEMBLY_PERSISTED_MESSAGE]?: true;
};
type ContextInjectionMetadata = {
  sources: ContextInjectionSource[];
  layer: 'runtime_system_message' | 'hook_message_buffer' | 'persistent_system_context';
};
type ContextInjectionMessage = Message & {
  [CONTEXT_INJECTION_METADATA]?: ContextInjectionMetadata;
};

const bufferedInjectionSources = new WeakMap<object, Set<ContextInjectionSource>>();

function markMessagePersistedByContextAssembly(message: Message): void {
  Object.defineProperty(message, CONTEXT_ASSEMBLY_PERSISTED_MESSAGE, {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

export function wasMessagePersistedByContextAssembly(message: Message): boolean {
  return (message as ContextAssemblyPersistedMessage)[CONTEXT_ASSEMBLY_PERSISTED_MESSAGE] === true;
}

function markMessageContextInjection(
  message: Message,
  sources: Iterable<ContextInjectionSource>,
  layer: ContextInjectionMetadata['layer'],
): void {
  const uniqueSources = Array.from(new Set(sources));
  Object.defineProperty(message, CONTEXT_INJECTION_METADATA, {
    value: { sources: uniqueSources, layer },
    enumerable: false,
    configurable: true,
  });
}

function getMessageContextInjection(message: Message): ContextInjectionMetadata | undefined {
  return (message as ContextInjectionMessage)[CONTEXT_INJECTION_METADATA];
}

export function injectSystemMessage(
  ctx: ContextAssemblyCtx,
  content: string,
  source: ContextInjectionSource,
  category?: string,
): void {
  const inferredCategory = category || ctx.inferBufferedSystemMessageCategory(content);
  if (inferredCategory) {
    // Buffer hook messages for later merging
    ctx.runtime.hookMessageBuffer.add(content, inferredCategory);
    let sources = bufferedInjectionSources.get(ctx.runtime.hookMessageBuffer);
    if (!sources) {
      sources = new Set();
      bufferedInjectionSources.set(ctx.runtime.hookMessageBuffer, sources);
    }
    sources.add(source);
    return;
  }

  // Direct injection for non-hook messages
  const systemMessage: Message = {
    id: ctx.generateId(),
    role: 'system',
    content,
    timestamp: Date.now(),
  };
  markMessageContextInjection(systemMessage, [source], 'runtime_system_message');
  ctx.runtime.messages.push(systemMessage);
  ctx.recordContextEventsForMessage(systemMessage);
}

export function flushHookMessageBuffer(ctx: ContextAssemblyCtx): void {
  const merged = ctx.runtime.hookMessageBuffer.flush();
  const sources = bufferedInjectionSources.get(ctx.runtime.hookMessageBuffer);
  bufferedInjectionSources.delete(ctx.runtime.hookMessageBuffer);
  if (merged) {
    const systemMessage: Message = {
      id: ctx.generateId(),
      role: 'system',
      content: merged,
      timestamp: Date.now(),
    };
    markMessageContextInjection(
      systemMessage,
      sources?.size ? sources : ['unattributed'],
      'hook_message_buffer',
    );
    ctx.runtime.messages.push(systemMessage);
    ctx.recordContextEventsForMessage(systemMessage);
    logger.debug(`[AgentLoop] Flushed ${ctx.runtime.hookMessageBuffer.size} buffered hook messages`);
  }
}

export function pushPersistentSystemContext(
  ctx: ContextAssemblyCtx,
  content: string,
  source: ContextInjectionSource,
): void {
  const normalized = normalizePersistentSystemContextKey(content);
  if (!normalized) return;
  const trimmed = content.trim();
  const ledgerMessage: Message = {
    id: ctx.generateId(),
    role: 'system',
    content: trimmed,
    timestamp: Date.now(),
  };
  markMessageContextInjection(ledgerMessage, [source], 'persistent_system_context');
  ctx.recordContextEventsForMessage(ledgerMessage);

  const existingIndex = ctx.runtime.contextHealth.persistentSystemContext.findIndex(
    (item) => normalizePersistentSystemContextKey(item) === normalized,
  );
  if (existingIndex >= 0) {
    const [existing] = ctx.runtime.contextHealth.persistentSystemContext.splice(existingIndex, 1);
    ctx.runtime.contextHealth.persistentSystemContext.push(existing);
    persistRuntimeState(ctx.runtime, { compressionState: false, persistentSystemContext: true });
    return;
  }

  ctx.runtime.contextHealth.persistentSystemContext.push(trimmed);
  ctx.trimPersistentSystemContext();
}

export function getBudgetedPersistentSystemContext(ctx: ContextAssemblyCtx): string[] {
  const selected: string[] = [];
  let usedTokens = 0;

  for (let i = ctx.runtime.contextHealth.persistentSystemContext.length - 1; i >= 0; i--) {
    const normalized = ctx.runtime.contextHealth.persistentSystemContext[i].trim();
    if (!normalized) continue;

    const trimmed = ctx.truncatePersistentSystemContext(normalized, MAX_PERSISTENT_SYSTEM_CONTEXT_ITEM_TOKENS);
    const itemTokens = estimateTokens(trimmed);
    if (selected.length >= MAX_PERSISTENT_SYSTEM_CONTEXT_ITEMS) continue;
    if (usedTokens + itemTokens > MAX_PERSISTENT_SYSTEM_CONTEXT_TOKENS) continue;

    selected.unshift(trimmed);
    usedTokens += itemTokens;
  }

  return selected;
}

export function trimPersistentSystemContext(ctx: ContextAssemblyCtx): void {
  const selected = ctx.getBudgetedPersistentSystemContext();
  ctx.runtime.contextHealth.persistentSystemContext.splice(0, ctx.runtime.contextHealth.persistentSystemContext.length, ...selected);
  persistRuntimeState(ctx.runtime, { compressionState: false, persistentSystemContext: true });
}

export function truncatePersistentSystemContext(ctx: ContextAssemblyCtx, content: string, maxTokens: number): string {
  const currentTokens = estimateTokens(content);
  if (currentTokens <= maxTokens) return content;

  const keepRatio = maxTokens / Math.max(currentTokens, 1);
  const keepChars = Math.max(160, Math.floor(content.length * keepRatio));
  return `${content.slice(0, keepChars).trimEnd()}\n...[truncated persistent context]...`;
}

export function inferBufferedSystemMessageCategory(ctx: ContextAssemblyCtx, content: string): string | undefined {
  const trimmed = content.trim();
  const knownTags = [
    'user-prompt-hook',
    'session-start-hook',
    'pre-tool-hook',
    'post-tool-hook',
    'post-tool-failure-hook',
    'stop-hook',
    'truncation-recovery',
    'wrap-up',
    'user-directives',
    'user-memory',
    'seed-memory',
    'session-recovery',
    'checkpoint-nudge',
  ];

  for (const tag of knownTags) {
    if (trimmed.startsWith(`<${tag}`) && trimmed.endsWith(`</${tag}>`)) {
      return tag;
    }
  }

  return undefined;
}

/**
 * 对话记录落库失败。message 直接进 `{type:'error'}` 事件给用户看（runFinalizer 的
 * formatTerminalError 只取 message，不带堆栈），所以写成人话而不是技术描述。
 */
class MessagePersistenceError extends Error {
  constructor() {
    super('对话记录写入失败，已停止本轮工具执行，避免产生记录里查不到的改动。请检查磁盘空间和数据库状态后重试。');
    this.name = 'MessagePersistenceError';
  }
}

export async function addAndPersistMessage(ctx: ContextAssemblyCtx, message: Message): Promise<void> {
  message.metadata = attachMessageCorrelation(ctx.runtime, message.metadata);
  if (ctx.runtime.historyVisibility === 'meta') {
    message.isMeta = true;
  }

  ctx.runtime.messages.push(message);
  ctx.recordContextEventsForMessage(message);

  // 单一统一路径：优先用 runtime.persistMessage callback（CLI/webServer/desktop 都注入了），
  // callback 缺失或失败时降级到 sessionManager.addMessageToSession（idempotent，重复写会自动 update）。
  // 任何写入失败用 logger.warn 输出，确保被默认日志级别捕获。
  // 两条路径**都**失败时抛（fail-closed）——调用方 messageProcessor 紧接着就 dispatch
  // 工具，落库不成还往下走等于执行一批记录里根本不存在的副作用，重启后无从追溯。
  let persisted = false;
  // 只有「真尝试写过且全失败」才算失败。没有 callback 也没有 sessionId 的运行时
  // （一次性/无持久化场景）本就不写库，那不是故障，不能拿它挡住工具。
  let attempted = false;

  if (ctx.runtime.persistMessage) {
    attempted = true;
    try {
      await ctx.runtime.persistMessage(message);
      persisted = true;
    } catch (error) {
      logger.warn('[ContextAssembly] persistMessage callback failed; falling back to sessionManager', {
        sessionId: ctx.runtime.sessionId,
        messageId: message.id,
        role: message.role,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!persisted && ctx.runtime.sessionId) {
    attempted = true;
    try {
      const sessionManager = getSessionManager();
      await sessionManager.addMessageToSession(ctx.runtime.sessionId, message);
      persisted = true;
    } catch (error) {
      logger.warn('[ContextAssembly] sessionManager.addMessageToSession failed', {
        sessionId: ctx.runtime.sessionId,
        messageId: message.id,
        role: message.role,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (persisted) {
    markMessagePersistedByContextAssembly(message);
    if (
      ctx.runtime.sessionId
      && message.role === 'assistant'
      && message.content.includes('```neo_ui')
    ) {
      try {
        const { getGenerativeUIService } = await import('../../../services/generativeUI/generativeUIService');
        getGenerativeUIService().admitMessage(ctx.runtime.sessionId, message);
      } catch (error) {
        logger.warn('[ContextAssembly] native generative UI admission failed', {
          sessionId: ctx.runtime.sessionId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    logger.warn('[ContextAssembly] message NOT persisted to db', {
      sessionId: ctx.runtime.sessionId,
      messageId: message.id,
      role: message.role,
      hasCallback: !!ctx.runtime.persistMessage,
    });
    if (attempted) throw new MessagePersistenceError();
  }
}

/**
 * 乙类落点（2026-08-08 notification 事件零消费者工单）：模型这次做了什么补救动作的过程
 * 说明，写成落库的 `role:'system'` 消息，登记进 USER_VISIBLE_SYSTEM_EVENT_REGISTRY 的
 * agentRecoveryNotice 项，回看对话时可见、不弹窗打断。
 *
 * 落库失败会向上抛（addAndPersistMessage 已改为 fail-closed）：补救说明写不进记录时，
 * 这一轮继续往下跑只会攒出一份查不到的历史，让它中断是对的。
 */
export async function writeAgentRecoveryNotice(
  ctx: ContextAssemblyCtx,
  kind: NonNullable<SystemEventMessageMetadata['agentRecoveryNotice']>['kind'],
  content: string,
): Promise<void> {
  await addAndPersistMessage(ctx, {
    id: ctx.generateId(),
    role: 'system',
    content,
    timestamp: Date.now(),
    metadata: { agentRecoveryNotice: { kind } } satisfies SystemEventMessageMetadata,
  });
}

export function recordContextEventsForMessage(ctx: ContextAssemblyCtx, message: Message): void {
  const events = ctx.buildContextEventsForMessage(message);
  if (events.length === 0) return;
  getContextEventLedger().upsertEvents(events);
}

export function buildContextEventsForMessage(ctx: ContextAssemblyCtx, message: Message): ContextEventRecord[] {
  const baseEvent = {
    id: '',
    sessionId: ctx.runtime.sessionId,
    agentId: ctx.runtime.agentId,
    messageId: message.id,
    timestamp: message.timestamp || Date.now(),
  };
  const events: ContextEventRecord[] = [];

  if (message.role === 'system') {
    if (message.compaction) {
      events.push({
        ...baseEvent,
        category: 'compression_survivor',
        action: 'compressed',
        sourceKind: 'compression_survivor',
        sourceDetail: 'compaction_block',
        layer: 'autocompact',
        reason: 'Compaction block retained in message history',
      });
    } else {
      const injection = getMessageContextInjection(message);
      const sources = injection?.sources.length ? injection.sources : ['unattributed'] as const;
      for (const source of sources) {
        events.push({
          ...baseEvent,
          category: 'system_anchor',
          action: 'added',
          sourceKind: source,
          sourceDetail: source,
          layer: injection?.layer,
          reason: source === 'unattributed'
            ? 'System message has no context injection source metadata'
            : `System context injected by ${source}`,
        });
      }
    }
  } else {
    events.push({
      ...baseEvent,
      category: 'recent_turn',
      action: 'added',
      sourceKind: 'message',
      sourceDetail: `${message.role}_message`,
      reason: `${message.role} message added to session history`,
    });
  }

  if ((message.attachments?.length ?? 0) > 0) {
    events.push({
      ...baseEvent,
      category: 'attachment',
      action: 'retrieved',
      sourceKind: 'attachment',
      sourceDetail: message.attachments?.map((attachment) => attachment.name).find(Boolean) || 'attachment',
      reason: 'Message includes attachment content',
    });
  }

  if ((message.toolCalls?.length ?? 0) > 0) {
    events.push({
      ...baseEvent,
      category: 'tool_result',
      action: 'retrieved',
      sourceKind: 'tool_result',
      sourceDetail: message.toolCalls?.map((toolCall) => toolCall.name).join(', ') || 'tool_call',
      layer: 'assistant_tool_call',
      reason: 'Assistant message contains tool calls',
    });
  }

  if (message.role === 'tool' || (message.toolResults?.length ?? 0) > 0) {
    events.push({
      ...baseEvent,
      category: 'tool_result',
      action: 'retrieved',
      sourceKind: 'tool_result',
      sourceDetail: message.toolResults?.map((toolResult) => toolResult.toolCallId).filter(Boolean).join(', ') || 'tool_result',
      layer: 'tool_execution',
      reason: 'Tool results captured in runtime history',
    });
  }

  return events;
}
