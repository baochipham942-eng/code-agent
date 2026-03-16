// ============================================================================
// Conversation Detector - 对话类型检测
// ============================================================================

import { SEARCH_TOOLS } from './evaluationPrompts';
import type { SessionSnapshot, ConversationType } from './types';

/**
 * 检测对话类型
 */
export function detectConversationType(snapshot: SessionSnapshot): ConversationType {
  const allToolCalls = snapshot.turns.length > 0
    ? snapshot.turns.flatMap(t => t.toolCalls)
    : snapshot.toolCalls;

  const toolNames = allToolCalls.map(tc => tc.name);
  const hasToolCalls = toolNames.length > 0;

  // 检查 assistant 消息中是否有代码块
  const sources = snapshot.turns.length > 0
    ? snapshot.turns.map(t => t.assistantResponse)
    : snapshot.messages.filter(m => m.role === 'assistant').map(m => m.content);
  const hasCodeBlocks = sources.some(content => /```\w*\n[\s\S]*?```/g.test(content));

  // 获取轮次数
  const turnCount = snapshot.turns.length > 0
    ? snapshot.turns.length
    : snapshot.messages.filter(m => m.role === 'user').length;

  // 检测条件（优先级：qa → coding → creation → research）

  // QA: 无工具调用 + 无代码块 + ≤3 轮
  if (!hasToolCalls && !hasCodeBlocks && turnCount <= 3) {
    return 'qa';
  }

  // Coding: 有代码工具(edit/write/read_file) 或有代码块
  const hasCodeTools = toolNames.some(name =>
    name === 'edit_file' || name === 'Edit' || name === 'write_file' || name === 'Write' ||
    (name === 'read_file' || name === 'Read') && toolNames.some(n => n === 'edit_file' || n === 'Edit' || n === 'write_file' || n === 'Write')
  );
  if (hasCodeTools || (hasCodeBlocks && hasToolCalls)) {
    return 'coding';
  }

  // Creation: 有内容创作工具
  const hasCreationTools = toolNames.some(name =>
    name === 'ppt_generate' || name === 'xlwings' ||
    // write_file 用于文档（非代码场景，此时 hasCodeTools 已经为 false）
    ((name === 'write_file' || name === 'Write') && !hasCodeTools)
  );
  if (hasCreationTools) {
    return 'creation';
  }

  // Research: 有搜索工具但无代码修改
  const hasSearchTools = toolNames.some(name => SEARCH_TOOLS.includes(name));
  if (hasSearchTools) {
    return 'research';
  }

  // Fallback: 有工具调用但不匹配任何类型 → coding
  if (hasToolCalls) {
    return 'coding';
  }

  // 无工具调用 + 超过 3 轮 → qa
  return 'qa';
}
