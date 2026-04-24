// ContextAssembly - Persistent system context stack and context event ledger.
import type { Message } from '../../../../shared/contract';
import type { ContextEventRecord } from '../../../context/contextEventLedger';
import { getSessionManager } from '../../../services';
import { estimateTokens } from '../../../context/tokenOptimizer';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import type { ContextAssemblyCtx } from '../contextAssembly';
import {
  logger,
  MAX_PERSISTENT_SYSTEM_CONTEXT_TOKENS,
  MAX_PERSISTENT_SYSTEM_CONTEXT_ITEMS,
  MAX_PERSISTENT_SYSTEM_CONTEXT_ITEM_TOKENS,
  normalizePersistentSystemContextKey,
} from '../contextAssembly';

export function injectSystemMessage(ctx: ContextAssemblyCtx, content: string, category?: string): void {
  const inferredCategory = category || ctx.inferBufferedSystemMessageCategory(content);
  if (inferredCategory) {
    // Buffer hook messages for later merging
    ctx.runtime.hookMessageBuffer.add(content, inferredCategory);
    return;
  }

  // Direct injection for non-hook messages
  const systemMessage: Message = {
    id: ctx.generateId(),
    role: 'system',
    content,
    timestamp: Date.now(),
  };
  ctx.runtime.messages.push(systemMessage);
  ctx.recordContextEventsForMessage(systemMessage);
}

export function flushHookMessageBuffer(ctx: ContextAssemblyCtx): void {
  const merged = ctx.runtime.hookMessageBuffer.flush();
  if (merged) {
    const systemMessage: Message = {
      id: ctx.generateId(),
      role: 'system',
      content: merged,
      timestamp: Date.now(),
    };
    ctx.runtime.messages.push(systemMessage);
    ctx.recordContextEventsForMessage(systemMessage);
    logger.debug(`[AgentLoop] Flushed ${ctx.runtime.hookMessageBuffer.size} buffered hook messages`);
  }
}

export function pushPersistentSystemContext(ctx: ContextAssemblyCtx, content: string): void {
  const normalized = normalizePersistentSystemContextKey(content);
  if (!normalized) return;
  const trimmed = content.trim();

  const existingIndex = ctx.runtime.persistentSystemContext.findIndex(
    (item) => normalizePersistentSystemContextKey(item) === normalized,
  );
  if (existingIndex >= 0) {
    const [existing] = ctx.runtime.persistentSystemContext.splice(existingIndex, 1);
    ctx.runtime.persistentSystemContext.push(existing);
    return;
  }

  ctx.runtime.persistentSystemContext.push(trimmed);
  ctx.trimPersistentSystemContext();
}

export function getBudgetedPersistentSystemContext(ctx: ContextAssemblyCtx): string[] {
  const selected: string[] = [];
  let usedTokens = 0;

  for (let i = ctx.runtime.persistentSystemContext.length - 1; i >= 0; i--) {
    const normalized = ctx.runtime.persistentSystemContext[i].trim();
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
  ctx.runtime.persistentSystemContext.splice(0, ctx.runtime.persistentSystemContext.length, ...selected);
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

export async function addAndPersistMessage(ctx: ContextAssemblyCtx, message: Message): Promise<void> {
  ctx.runtime.messages.push(message);
  ctx.recordContextEventsForMessage(message);

  if (process.env.CODE_AGENT_CLI_MODE === 'true') {
    // CLI 模式：通过回调持久化（包含 tool_results）
    if (ctx.runtime.persistMessage) {
      try {
        await ctx.runtime.persistMessage(message);
      } catch (error) {
        logger.error('Failed to persist message (CLI):', error);
      }
    }
    return;
  }

  try {
    const sessionManager = getSessionManager();
    await sessionManager.addMessage(message);
  } catch (error) {
    logger.error('Failed to persist message:', error);
  }
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
    events.push({
      ...baseEvent,
      category: message.compaction ? 'compression_survivor' : 'system_anchor',
      action: message.compaction ? 'compressed' : 'added',
      sourceKind: message.compaction ? 'compression_survivor' : 'system_anchor',
      sourceDetail: message.compaction ? 'compaction_block' : 'system_message',
      layer: message.compaction ? 'autocompact' : undefined,
      reason: message.compaction
        ? 'Compaction block retained in message history'
        : 'System message injected into runtime context',
    });
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
