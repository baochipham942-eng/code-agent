// ============================================================================
// Context Hooks - 上下文保留钩子
// PreCompact: 压缩上下文前保留关键信息
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { CompactContext, HookExecutionResult } from '../events';
import type { Message } from '../../../shared/types';

const logger = createLogger('ContextHooks');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 需要保留的上下文信息
 */
export interface PreservedContext {
  /** 关键决策点 */
  decisions: Array<{
    description: string;
    timestamp: number;
    importance: 'high' | 'medium' | 'low';
  }>;
  /** 重要的代码变更 */
  codeChanges: Array<{
    file: string;
    operation: 'create' | 'edit' | 'delete';
    summary: string;
  }>;
  /** 待办事项状态 */
  todoStatus: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  /** 用户明确的要求 */
  userRequirements: string[];
  /** 当前工作上下文 */
  workingContext: {
    currentTask?: string;
    currentFiles?: string[];
    pendingActions?: string[];
  };
}

/**
 * 压缩策略
 */
export type CompactionStrategy =
  | 'aggressive'    // 激进压缩，仅保留最关键信息
  | 'balanced'      // 平衡压缩
  | 'conservative'; // 保守压缩，尽量保留更多上下文

// ----------------------------------------------------------------------------
// Pre-Compact Hook
// ----------------------------------------------------------------------------

/**
 * 压缩上下文前保留关键信息
 *
 * 在上下文压缩前分析消息历史，提取需要保留的关键信息，
 * 确保压缩后不丢失重要上下文。
 */
export async function preCompactContextHook(
  context: CompactContext,
  messages: Message[],
  strategy: CompactionStrategy = 'balanced'
): Promise<HookExecutionResult> {
  const startTime = Date.now();

  try {
    // 提取需要保留的上下文
    const preserved = extractPreservedContext(messages, strategy);

    // 计算压缩比例
    const compressionRatio = context.targetTokenCount / context.tokenCount;
    logger.info(`Pre-compact: ${context.tokenCount} -> ${context.targetTokenCount} (${Math.round(compressionRatio * 100)}%)`);

    // 根据策略调整保留内容
    const filteredPreserved = filterByStrategy(preserved, strategy, compressionRatio);

    // 生成保留信息摘要
    const preservationSummary = generatePreservationSummary(filteredPreserved);

    if (preservationSummary) {
      logger.info('Context preservation summary generated', {
        decisions: filteredPreserved.decisions.length,
        codeChanges: filteredPreserved.codeChanges.length,
        requirements: filteredPreserved.userRequirements.length,
      });

      return {
        action: 'continue',
        message: preservationSummary,
        duration: Date.now() - startTime,
      };
    }

    return {
      action: 'continue',
      duration: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Pre-compact hook failed:', error);
    return {
      action: 'continue', // Don't block compaction on failure
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}

// ----------------------------------------------------------------------------
// Context Extraction
// ----------------------------------------------------------------------------

/**
 * 从消息历史中提取需要保留的上下文
 */
function extractPreservedContext(
  messages: Message[],
  strategy: CompactionStrategy
): PreservedContext {
  const preserved: PreservedContext = {
    decisions: [],
    codeChanges: [],
    todoStatus: [],
    userRequirements: [],
    workingContext: {},
  };

  // 提取关键决策
  preserved.decisions = extractDecisions(messages, strategy);

  // 提取代码变更
  preserved.codeChanges = extractCodeChanges(messages);

  // 提取待办状态
  preserved.todoStatus = extractTodoStatus(messages);

  // 提取用户要求
  preserved.userRequirements = extractUserRequirements(messages);

  // 提取当前工作上下文
  preserved.workingContext = extractWorkingContext(messages);

  return preserved;
}

/**
 * 提取关键决策
 */
function extractDecisions(
  messages: Message[],
  strategy: CompactionStrategy
): PreservedContext['decisions'] {
  const decisions: PreservedContext['decisions'] = [];
  const decisionKeywords = ['决定', '选择', '采用', 'decide', 'choose', 'use', '方案', 'approach'];

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (!message.content) continue;

    // 检查是否包含决策关键词
    const hasDecision = decisionKeywords.some(kw =>
      message.content!.toLowerCase().includes(kw.toLowerCase())
    );

    if (hasDecision) {
      // 提取决策描述（第一句话或前 100 字符）
      const firstSentence = message.content.split(/[.。!！?？]/)[0];
      const description = firstSentence.substring(0, 100);

      // 根据策略判断重要性
      let importance: 'high' | 'medium' | 'low' = 'medium';
      if (message.content.includes('重要') || message.content.includes('关键') ||
          message.content.includes('important') || message.content.includes('critical')) {
        importance = 'high';
      }

      decisions.push({
        description,
        timestamp: message.timestamp,
        importance,
      });
    }
  }

  // 根据策略限制数量
  const limit = strategy === 'aggressive' ? 3 : strategy === 'balanced' ? 5 : 10;
  return decisions
    .sort((a, b) => {
      const importanceOrder = { high: 0, medium: 1, low: 2 };
      return importanceOrder[a.importance] - importanceOrder[b.importance];
    })
    .slice(0, limit);
}

/**
 * 提取代码变更
 */
function extractCodeChanges(messages: Message[]): PreservedContext['codeChanges'] {
  const changes: PreservedContext['codeChanges'] = [];

  for (const message of messages) {
    if (!message.toolCalls) continue;

    for (const toolCall of message.toolCalls) {
      if (['write_file', 'edit_file'].includes(toolCall.name)) {
        const filePath = toolCall.arguments?.file_path as string;
        if (filePath) {
          changes.push({
            file: filePath,
            operation: toolCall.name === 'write_file' ? 'create' : 'edit',
            summary: `${toolCall.name} on ${filePath}`,
          });
        }
      }
    }
  }

  // 去重，保留最后一次操作
  const uniqueChanges = new Map<string, PreservedContext['codeChanges'][0]>();
  for (const change of changes) {
    uniqueChanges.set(change.file, change);
  }

  return Array.from(uniqueChanges.values());
}

/**
 * 提取待办状态
 */
function extractTodoStatus(messages: Message[]): PreservedContext['todoStatus'] {
  const todos: PreservedContext['todoStatus'] = [];

  // 从消息中查找 todo_write 工具调用
  for (const message of messages) {
    if (!message.toolCalls) continue;

    for (const toolCall of message.toolCalls) {
      if (toolCall.name === 'todo_write') {
        const todoList = toolCall.arguments?.todos as Array<{
          content: string;
          status: string;
        }>;

        if (todoList) {
          // 只保留最新的 todo 状态
          todos.length = 0;
          for (const todo of todoList) {
            todos.push({
              content: todo.content,
              status: todo.status as 'pending' | 'in_progress' | 'completed',
            });
          }
        }
      }
    }
  }

  return todos;
}

/**
 * 提取用户要求
 */
function extractUserRequirements(messages: Message[]): string[] {
  const requirements: string[] = [];

  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (!message.content) continue;
    // 多轮对话中每条用户消息都可能是指令，不再用关键词过滤
    if (message.content.length <= 10) continue;

    const requirement = message.content.substring(0, 500);
    if (!requirements.includes(requirement)) {
      requirements.push(requirement);
    }
  }

  return requirements.slice(-8); // 保留最近 8 个要求
}

/**
 * 提取当前工作上下文
 */
function extractWorkingContext(messages: Message[]): PreservedContext['workingContext'] {
  const context: PreservedContext['workingContext'] = {};

  // 从最近的消息中提取当前任务
  const recentUserMessages = messages
    .filter(m => m.role === 'user')
    .slice(-3);

  if (recentUserMessages.length > 0) {
    context.currentTask = recentUserMessages[recentUserMessages.length - 1].content?.substring(0, 200);
  }

  // 提取最近操作的文件
  const recentFiles = new Set<string>();
  const recentMessages = messages.slice(-10);

  for (const message of recentMessages) {
    if (!message.toolCalls) continue;

    for (const toolCall of message.toolCalls) {
      const filePath = toolCall.arguments?.file_path as string;
      if (filePath) {
        recentFiles.add(filePath);
      }
    }
  }

  context.currentFiles = Array.from(recentFiles);

  return context;
}

// ----------------------------------------------------------------------------
// Filtering and Summary
// ----------------------------------------------------------------------------

/**
 * 根据策略过滤保留内容
 */
function filterByStrategy(
  preserved: PreservedContext,
  strategy: CompactionStrategy,
  compressionRatio: number
): PreservedContext {
  const filtered = { ...preserved };

  if (strategy === 'aggressive' || compressionRatio < 0.3) {
    // 激进压缩：只保留高重要性决策和必要的代码变更
    filtered.decisions = preserved.decisions.filter(d => d.importance === 'high');
    filtered.codeChanges = preserved.codeChanges.slice(-3);
    filtered.userRequirements = preserved.userRequirements.slice(-5);
    filtered.todoStatus = preserved.todoStatus.filter(t => t.status !== 'completed');
  } else if (strategy === 'balanced' || compressionRatio < 0.5) {
    // 平衡压缩
    filtered.decisions = preserved.decisions.filter(d => d.importance !== 'low');
    filtered.codeChanges = preserved.codeChanges.slice(-5);
    filtered.userRequirements = preserved.userRequirements.slice(-5);
  }
  // conservative 策略保留全部

  return filtered;
}

/**
 * 生成保留信息摘要
 */
function generatePreservationSummary(preserved: PreservedContext): string | null {
  const parts: string[] = [];

  // 工作上下文
  if (preserved.workingContext.currentTask) {
    parts.push(`**当前任务**: ${preserved.workingContext.currentTask}`);
  }

  // 关键决策
  if (preserved.decisions.length > 0) {
    const decisionLines = preserved.decisions
      .map(d => `- [${d.importance}] ${d.description}`)
      .join('\n');
    parts.push(`**关键决策**:\n${decisionLines}`);
  }

  // 代码变更
  if (preserved.codeChanges.length > 0) {
    const changeLines = preserved.codeChanges
      .map(c => `- ${c.operation}: ${c.file}`)
      .join('\n');
    parts.push(`**代码变更**:\n${changeLines}`);
  }

  // 待办事项
  if (preserved.todoStatus.length > 0) {
    const todoLines = preserved.todoStatus
      .map(t => `- [${t.status}] ${t.content}`)
      .join('\n');
    parts.push(`**待办事项**:\n${todoLines}`);
  }

  // 用户要求
  if (preserved.userRequirements.length > 0) {
    const reqLines = preserved.userRequirements
      .map(r => `- ${r}`)
      .join('\n');
    parts.push(`**用户要求**:\n${reqLines}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `---\n**上下文保留摘要**（压缩前提取）:\n\n${parts.join('\n\n')}\n---`;
}
