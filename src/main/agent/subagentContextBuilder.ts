// ============================================================================
// Subagent Context Builder - 上下文注入机制
// Phase 0: 修复 Subagent 上下文传递
// ============================================================================
//
// 问题：Subagent 只能看到静态系统提示，看不到：
// - 对话历史、工具执行结果、会话状态、已修改文件等
//
// 解决方案：三层上下文策略
// - minimal: 只传递任务描述（快速执行，探索类）
// - relevant: 传递最近消息 + 工具结果摘要（规划/审查类）
// - full: 传递完整历史摘要（执行类，需要完整上下文）
// ============================================================================

import type { Message, ToolResult } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SubagentContextBuilder');

// ============================================================================
// Types
// ============================================================================

/**
 * 上下文级别
 * - minimal: 最小上下文（~500 tokens）- 只有任务描述
 * - relevant: 相关上下文（~1500 tokens）- 最近消息 + 工具结果
 * - full: 完整上下文（~3000 tokens）- 包含历史摘要
 */
export type ContextLevel = 'minimal' | 'relevant' | 'full';

/**
 * 工具结果摘要
 */
export interface ToolResultSummary {
  /** 工具名称 */
  tool: string;
  /** 结果摘要 */
  summary: string;
  /** 是否成功 */
  success: boolean;
  /** 时间戳 */
  timestamp: number;
}

/**
 * TODO 项
 */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/**
 * Subagent 上下文
 */
export interface SubagentContext {
  // 必要上下文（所有级别都包含）
  /** 当前任务描述 */
  taskDescription: string;
  /** 用户意图摘要 */
  userIntent: string;

  // 相关上下文（relevant 和 full 级别包含）
  /** 最近消息（去除系统消息） */
  recentMessages: Message[];
  /** 最近工具结果摘要 */
  recentToolResults: ToolResultSummary[];
  /** 当前 TODO 列表 */
  currentTodos: TodoItem[];
  /** 已修改文件列表 */
  modifiedFiles: string[];

  // 完整上下文（仅 full 级别包含）
  /** 完整对话摘要（压缩） */
  fullHistorySummary?: string;
}

/**
 * SubagentContextBuilder 配置
 */
export interface SubagentContextBuilderConfig {
  /** 会话 ID */
  sessionId: string;
  /** 对话历史 */
  messages: Message[];
  /** 上下文级别 */
  contextLevel?: ContextLevel;
  /** TODO 列表（可选） */
  todos?: TodoItem[];
  /** 已修改文件（可选） */
  modifiedFiles?: Set<string>;
  /** 最近消息数量限制 */
  recentMessageLimit?: number;
  /** 最近工具结果数量限制 */
  recentToolResultLimit?: number;
}

// ============================================================================
// Agent 类型到上下文级别的映射
// ============================================================================

/**
 * Agent 类型的默认上下文级别配置
 *
 * - 探索类：minimal（快速执行，不需要太多上下文）
 * - 规划/审查类：relevant（需要了解当前状态）
 * - 执行类：full（需要完整理解任务背景）
 */
export const AGENT_CONTEXT_LEVELS: Record<string, ContextLevel> = {
  // T0: 协调层（需要完整上下文）
  'orchestrator': 'full',

  // 探索类：最小上下文（快速执行）
  'explorer': 'minimal',
  'code-explore': 'minimal',
  'doc-reader': 'minimal',
  'web-search': 'minimal',
  'researcher': 'minimal',

  // 规划类：相关上下文
  'planner': 'relevant',
  'plan': 'relevant',
  'architect': 'relevant',

  // 审查类：相关上下文
  'reviewer': 'relevant',
  'visual-understanding': 'relevant',

  // 执行类：完整上下文
  'coder': 'full',
  'debugger': 'full',
  'tester': 'relevant',
  'refactorer': 'relevant',
  'devops': 'relevant',
  'documenter': 'relevant',

  // 等待类
  'awaiter': 'minimal',

  // 其他
  'general-purpose': 'full',
  'bash-executor': 'minimal',
  'mcp-connector': 'relevant',
  'visual-processing': 'relevant',
};

/**
 * 获取 Agent 类型的上下文级别
 */
export function getAgentContextLevel(agentType: string): ContextLevel {
  return AGENT_CONTEXT_LEVELS[agentType] || 'relevant';
}

// ============================================================================
// SubagentContextBuilder 类
// ============================================================================

/**
 * Subagent 上下文构建器
 *
 * 负责从当前会话中提取相关上下文，并格式化为系统提示注入
 */
export class SubagentContextBuilder {
  private sessionId: string;
  private messages: Message[];
  private contextLevel: ContextLevel;
  private todos: TodoItem[];
  private modifiedFiles: Set<string>;
  private recentMessageLimit: number;
  private recentToolResultLimit: number;

  constructor(config: SubagentContextBuilderConfig) {
    this.sessionId = config.sessionId;
    this.messages = config.messages || [];
    this.contextLevel = config.contextLevel || 'relevant';
    this.todos = config.todos || [];
    this.modifiedFiles = config.modifiedFiles || new Set();
    this.recentMessageLimit = config.recentMessageLimit || 5;
    this.recentToolResultLimit = config.recentToolResultLimit || 8;
  }

  /**
   * 构建 Subagent 上下文
   */
  async build(taskPrompt: string): Promise<SubagentContext> {
    // 1. 提取用户意图（所有级别）
    const userIntent = this.extractUserIntent();

    // 2. 根据级别构建上下文
    if (this.contextLevel === 'minimal') {
      return {
        taskDescription: taskPrompt,
        userIntent,
        recentMessages: [],
        recentToolResults: [],
        currentTodos: [],
        modifiedFiles: [],
      };
    }

    // relevant 和 full 级别
    const recentMessages = this.getRecentMessages();
    const recentToolResults = this.summarizeToolResults();
    const modifiedFilesList = Array.from(this.modifiedFiles);

    const context: SubagentContext = {
      taskDescription: taskPrompt,
      userIntent,
      recentMessages,
      recentToolResults,
      currentTodos: this.todos,
      modifiedFiles: modifiedFilesList,
    };

    // 3. full 级别：添加完整历史摘要
    if (this.contextLevel === 'full') {
      context.fullHistorySummary = this.generateHistorySummary();
    }

    logger.debug('Built subagent context', {
      level: this.contextLevel,
      recentMessagesCount: recentMessages.length,
      recentToolResultsCount: recentToolResults.length,
      todosCount: this.todos.length,
      modifiedFilesCount: modifiedFilesList.length,
      hasHistorySummary: !!context.fullHistorySummary,
    });

    return context;
  }

  /**
   * 提取用户意图摘要
   *
   * 从最近的用户消息中提取核心意图
   */
  private extractUserIntent(): string {
    // 找到最近的用户消息
    const userMessages = this.messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) {
      return '未指定明确意图';
    }

    // 获取最近的用户消息
    const latestUserMessage = userMessages[userMessages.length - 1];
    const content = latestUserMessage.content;

    // 如果消息较短，直接返回
    if (content.length <= 200) {
      return content;
    }

    // 较长消息，提取前 200 字符 + 省略提示
    return content.substring(0, 200) + '...';
  }

  /**
   * 获取最近的非系统消息
   */
  private getRecentMessages(): Message[] {
    // 过滤掉系统消息和 meta 消息
    const relevantMessages = this.messages.filter(
      m => m.role !== 'system' && !m.isMeta
    );

    // 取最近 N 条
    return relevantMessages.slice(-this.recentMessageLimit);
  }

  /**
   * 提取并摘要最近的工具执行结果
   */
  private summarizeToolResults(): ToolResultSummary[] {
    const toolResults: ToolResultSummary[] = [];

    // 遍历消息，提取工具结果
    for (const message of this.messages) {
      if (message.toolResults && message.toolResults.length > 0) {
        for (const result of message.toolResults) {
          toolResults.push({
            tool: this.getToolNameFromResult(result, message),
            summary: this.summarizeToolOutput(result),
            success: result.success,
            timestamp: message.timestamp,
          });
        }
      }
    }

    // 按时间排序，取最近 N 个
    toolResults.sort((a, b) => b.timestamp - a.timestamp);
    return toolResults.slice(0, this.recentToolResultLimit);
  }

  /**
   * 摘要单个工具输出
   */
  private summarizeToolOutput(result: ToolResult): string {
    const output = result.output || result.error || '';

    // 短输出直接返回
    if (output.length <= 100) {
      return output;
    }

    // 长输出截断
    return output.substring(0, 100) + '...';
  }

  /**
   * 从消息中提取工具名称
   * (ToolResult 没有 toolName，需要从 toolCalls 中关联)
   */
  private getToolNameFromResult(result: ToolResult, message: Message): string {
    // 尝试从同一消息的 toolCalls 中找到匹配的工具名
    if (message.toolCalls) {
      const matchingCall = message.toolCalls.find(tc => tc.id === result.toolCallId);
      if (matchingCall) {
        return matchingCall.name;
      }
    }
    return 'unknown';
  }

  /**
   * 生成完整对话历史摘要
   */
  private generateHistorySummary(): string {
    if (this.messages.length === 0) {
      return '';
    }

    const summaryParts: string[] = [];

    // 1. 统计基本信息
    const userMsgCount = this.messages.filter(m => m.role === 'user').length;
    const assistantMsgCount = this.messages.filter(m => m.role === 'assistant').length;
    const toolCallCount = this.messages.reduce(
      (count, m) => count + (m.toolCalls?.length || 0),
      0
    );

    summaryParts.push(
      `对话统计：${userMsgCount} 条用户消息，${assistantMsgCount} 条助手回复，${toolCallCount} 次工具调用`
    );

    // 2. 提取关键操作（从工具调用中）
    const keyOperations = this.extractKeyOperations();
    if (keyOperations.length > 0) {
      summaryParts.push(`关键操作：${keyOperations.join('、')}`);
    }

    // 3. 提取已读文件
    const readFiles = this.extractReadFiles();
    if (readFiles.length > 0) {
      const fileList = readFiles.slice(0, 5).join(', ');
      const suffix = readFiles.length > 5 ? ` 等 ${readFiles.length} 个文件` : '';
      summaryParts.push(`已读取：${fileList}${suffix}`);
    }

    // 4. 已修改文件
    if (this.modifiedFiles.size > 0) {
      const modifiedList = Array.from(this.modifiedFiles).slice(0, 5).join(', ');
      const suffix = this.modifiedFiles.size > 5 ? ` 等 ${this.modifiedFiles.size} 个文件` : '';
      summaryParts.push(`已修改：${modifiedList}${suffix}`);
    }

    return summaryParts.join('\n');
  }

  /**
   * 从工具调用中提取关键操作类型
   */
  private extractKeyOperations(): string[] {
    const operations = new Set<string>();

    for (const message of this.messages) {
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          // 映射工具名到操作描述
          const op = this.toolToOperation(call.name);
          if (op) {
            operations.add(op);
          }
        }
      }
    }

    return Array.from(operations);
  }

  /**
   * 工具名映射到操作描述
   */
  private toolToOperation(toolName: string): string | null {
    const mapping: Record<string, string> = {
      'read_file': '文件读取',
      'write_file': '文件写入',
      'edit_file': '文件编辑',
      'bash': '命令执行',
      'glob': '文件搜索',
      'grep': '内容搜索',
      'web_search': '网络搜索',
      'web_fetch': '网页获取',
      'Task': 'Agent 委托',
      'spawn_agent': 'Agent 创建',
    };
    return mapping[toolName] || null;
  }

  /**
   * 提取已读取的文件列表
   */
  private extractReadFiles(): string[] {
    const readFiles = new Set<string>();

    for (const message of this.messages) {
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          if (call.name === 'read_file' || call.name === 'Read') {
            const filePath = call.arguments?.file_path || call.arguments?.path;
            if (typeof filePath === 'string') {
              // 提取文件名（不含完整路径）
              const fileName = filePath.split('/').pop() || filePath;
              readFiles.add(fileName);
            }
          }
        }
      }
    }

    return Array.from(readFiles);
  }

  /**
   * 格式化上下文为系统提示注入
   */
  formatForSystemPrompt(context: SubagentContext): string {
    const sections: string[] = [];

    // 1. 用户意图（所有级别）
    if (context.userIntent) {
      sections.push(`## 用户意图\n${context.userIntent}`);
    }

    // 2. 任务进度（relevant/full）
    if (context.currentTodos.length > 0) {
      const todoLines = context.currentTodos.map(t => {
        const statusEmoji = {
          'pending': '⏳',
          'in_progress': '🔄',
          'completed': '✅',
          'cancelled': '❌',
        }[t.status];
        return `- ${statusEmoji} ${t.content}`;
      });
      sections.push(`## 当前任务进度\n${todoLines.join('\n')}`);
    }

    // 3. 最近操作（relevant/full）
    if (context.recentToolResults.length > 0) {
      const toolLines = context.recentToolResults.map(r => {
        const status = r.success ? '✓' : '✗';
        return `- [${status}] ${r.tool}: ${r.summary}`;
      });
      sections.push(`## 最近操作\n${toolLines.join('\n')}`);
    }

    // 4. 已修改文件（relevant/full）
    if (context.modifiedFiles.length > 0) {
      sections.push(`## 已修改文件\n${context.modifiedFiles.join(', ')}`);
    }

    // 5. 历史摘要（仅 full）
    if (context.fullHistorySummary) {
      sections.push(`## 历史摘要\n${context.fullHistorySummary}`);
    }

    // 组装
    if (sections.length === 0) {
      return '';
    }

    return `\n\n---\n# 当前会话上下文\n\n${sections.join('\n\n')}`;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Subagent 上下文构建器
 */
export function createSubagentContextBuilder(
  config: SubagentContextBuilderConfig
): SubagentContextBuilder {
  return new SubagentContextBuilder(config);
}

/**
 * 快速构建并格式化上下文（便捷方法）
 */
export async function buildSubagentContextPrompt(
  config: SubagentContextBuilderConfig,
  taskPrompt: string
): Promise<string> {
  const builder = new SubagentContextBuilder(config);
  const context = await builder.build(taskPrompt);
  return builder.formatForSystemPrompt(context);
}
