// ============================================================================
// Fork Context - 基于 fork 的 Prompt Cache 共享
// 多 subagent 共享字节一致的前缀，最大化 Anthropic API 缓存命中
// ============================================================================

import type { Message, ToolDefinition } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ForkContext');

// ============================================================================
// 类型定义
// ============================================================================

export interface ForkContext {
  /** 所有 fork 子代共享的字节一致前缀 */
  sharedPrefix: {
    systemPrompt: string;
    tools: ToolDefinition[];
    messages: Message[];
  };
  /** 每个子代独有的指令 */
  childDirective: string;
}

export interface ForkOptions {
  /** 父级系统提示 */
  systemPrompt: string;
  /** 父级工具定义 */
  tools: ToolDefinition[];
  /** fork 点之前的父级消息历史 */
  messages: Message[];
  /** 每个子代的独立提示（每个子代获得一个唯一指令） */
  childPrompts: string[];
}

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 为多个 subagent 构建 fork 上下文。
 * 所有子代共享相同前缀（systemPrompt + tools + messages），
 * 仅最终 user message 因子代而异。
 *
 * @returns ForkContext 数组，每个子代对应一个
 */
export function buildForkContexts(options: ForkOptions): ForkContext[] {
  const { systemPrompt, tools, messages, childPrompts } = options;

  if (childPrompts.length === 0) {
    logger.warn('buildForkContexts called with empty childPrompts');
    return [];
  }

  // 共享前缀对所有子代完全相同（引用同一对象，序列化后字节一致）
  const sharedPrefix = {
    systemPrompt,
    tools,
    messages,
  };

  logger.debug(
    `Building ${childPrompts.length} fork contexts, shared prefix: ${messages.length} messages`
  );

  return childPrompts.map((directive) => ({
    sharedPrefix,
    childDirective: directive,
  }));
}

/**
 * 为子代 agent 构建 forked 消息序列。
 * 在共享前缀消息之后追加子代特有的 user message。
 *
 * 父级最后一条 assistant 消息（含 tool_use blocks）会被保留。
 * 为每个 tool_use block 生成占位 tool_result（跨子代字节一致）。
 * 仅最终 text block 因子代而异（即指令内容）。
 */
export function buildForkedMessages(
  sharedMessages: Message[],
  childDirective: string
): Message[] {
  const cloned = structuredClone(sharedMessages);

  // 找到最后一条包含 tool_use 的 assistant 消息
  const lastAssistantWithTools = findLastAssistantWithToolUse(cloned);

  // 构建 user message：占位 tool_results + 子代指令
  const toolResults = lastAssistantWithTools
    ? buildPlaceholderToolResults(lastAssistantWithTools)
    : [];

  const childMessage: Message = {
    id: `fork_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: childDirective,
    timestamp: Date.now(),
    ...(toolResults.length > 0 ? { toolResults } : {}),
  };

  cloned.push(childMessage);

  return cloned;
}

/**
 * 判断是否应启用 fork 模式。
 * 仅在同一轮次 spawn 2+ 个 subagent 时 fork 才有收益。
 */
export function shouldUseForkMode(childCount: number): boolean {
  return childCount >= 2;
}

/**
 * 在共享前缀的最后一个 content block 上添加 cache_control 标记。
 * 告知 Anthropic API 缓存此点之前的所有内容。
 */
export function applyCacheControl(messages: Message[]): Message[] {
  if (messages.length === 0) {
    return [];
  }

  const cloned = structuredClone(messages);
  const lastMessage = cloned[cloned.length - 1];

  // 优先使用 contentParts（结构化内容块）
  if (lastMessage.contentParts && lastMessage.contentParts.length > 0) {
    const lastPart = lastMessage.contentParts[lastMessage.contentParts.length - 1];
    (lastPart as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  } else {
    // fallback: 在消息本身打标记
    (lastMessage as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }

  return cloned;
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 从消息列表中找到最后一条包含 toolCalls 的 assistant 消息
 */
function findLastAssistantWithToolUse(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      return msg;
    }
  }
  return null;
}

/**
 * 为 assistant 消息中的每个 tool_use 生成占位 tool_result。
 * 所有子代使用相同的占位内容（"Acknowledged"），确保字节一致。
 */
function buildPlaceholderToolResults(assistantMessage: Message): Array<{
  toolCallId: string;
  success: boolean;
  output: string;
}> {
  if (!assistantMessage.toolCalls) {
    return [];
  }

  return assistantMessage.toolCalls.map((toolCall) => ({
    toolCallId: toolCall.id,
    success: true,
    output: 'Acknowledged',
  }));
}
