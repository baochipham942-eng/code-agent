// ============================================================================
// Fork Session Tool - 会话 Fork 工具
// ============================================================================
// 检索与当前任务相关的历史会话，支持用户选择 Fork 继承上下文。
// 实现 Smart Forking 的用户交互层。
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import {
  getForkDetector,
  type ForkDetectionResult,
  type RelevantSession,
} from '../../memory/forkDetector';
import {
  getContextInjector,
  type InjectedContext,
} from '../../memory/contextInjector';
import { getSessionSummarizer } from '../../memory/sessionSummarizer';
import { getDatabase } from '../../services';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ForkSessionTool');

// ----------------------------------------------------------------------------
// Tool Definition
// ----------------------------------------------------------------------------

export const forkSessionTool: Tool = {
  name: 'fork_session',
  description: `检索与当前任务相关的历史会话，可选择继承其上下文。

使用场景：
- 开始新任务时，检查是否有相关的历史讨论
- 继续之前的工作，无需重复解释背景
- 查找之前做过的类似任务作为参考

工作流程：
1. 调用此工具描述你想做的任务
2. 系统返回相关历史会话列表
3. 选择要 Fork 的会话（通过 session_id）
4. 系统自动注入历史上下文

示例：
- fork_session { "query": "实现用户认证" }  -> 查找认证相关会话
- fork_session { "query": "优化数据库查询" }  -> 查找数据库相关会话
- fork_session { "session_id": "abc123" }  -> 直接 Fork 指定会话`,

  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '描述你想做什么任务，用于检索相关历史会话',
      },
      session_id: {
        type: 'string',
        description: '直接指定要 Fork 的会话 ID（跳过检索）',
      },
      project_path: {
        type: 'string',
        description: '限定在特定项目内搜索',
      },
      list_recent: {
        type: 'boolean',
        description: '列出最近的会话（不进行语义检索）',
      },
      limit: {
        type: 'number',
        description: '返回结果数量限制（默认 5）',
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = params.query as string | undefined;
    const sessionId = params.session_id as string | undefined;
    const projectPath = (params.project_path as string) || (context as unknown as Record<string, unknown>).projectPath as string | undefined;
    const listRecent = params.list_recent as boolean | undefined;
    const limit = (params.limit as number) || 5;

    try {
      // 模式 1: 直接 Fork 指定会话
      if (sessionId) {
        return await forkSpecificSession(sessionId);
      }

      // 模式 2: 列出最近会话
      if (listRecent) {
        return await listRecentSessions(limit, projectPath);
      }

      // 模式 3: 语义检索相关会话
      if (query) {
        return await searchAndSuggestSessions(query, projectPath);
      }

      // 无有效参数
      return {
        success: false,
        error: '请提供 query（检索）、session_id（直接 Fork）或 list_recent: true（列出最近会话）',
      };
    } catch (error) {
      logger.error('Fork session tool error', { error });
      return {
        success: false,
        error: `Fork session 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * Fork 指定会话
 */
async function forkSpecificSession(
  sessionId: string
): Promise<ToolExecutionResult> {
  logger.info('Forking specific session', { sessionId });

  const injector = getContextInjector();
  const context = await injector.buildInjectedContext(sessionId);

  if (!context) {
    return {
      success: false,
      error: `找不到会话 ${sessionId} 或会话没有消息`,
    };
  }

  // 格式化输出
  const systemPromptFragment = injector.formatForSystemPrompt(context);
  const userMessage = injector.formatForUserMessage(context);

  return {
    success: true,
    output: formatForkResult(context, systemPromptFragment, userMessage),
    metadata: {
      action: 'forked',
      sessionId: context.fromSession.id,
      title: context.fromSession.title,
      keyMessagesCount: context.keyMessages.length,
      warningsCount: context.warnings.length,
      // 将 system prompt 片段作为元数据传递，供 Agent 使用
      systemPromptFragment,
    },
  };
}

/**
 * 列出最近会话
 */
async function listRecentSessions(
  limit: number,
  projectPath?: string
): Promise<ToolExecutionResult> {
  logger.info('Listing recent sessions', { limit, projectPath });

  const detector = getForkDetector();

  let sessions: RelevantSession[];
  if (projectPath) {
    sessions = await detector.getSessionsByProject(projectPath, limit);
  } else {
    sessions = await detector.getRecentSessions(limit);
  }

  if (sessions.length === 0) {
    return {
      success: true,
      output: '没有找到历史会话记录。',
      metadata: { action: 'list', count: 0 },
    };
  }

  return {
    success: true,
    output: formatSessionList(sessions, '最近的会话'),
    metadata: {
      action: 'list',
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.sessionId,
        title: s.title,
        createdAt: s.createdAt,
      })),
    },
  };
}

/**
 * 搜索并建议会话
 */
async function searchAndSuggestSessions(
  query: string,
  projectPath?: string
): Promise<ToolExecutionResult> {
  logger.info('Searching for relevant sessions', { query, projectPath });

  const detector = getForkDetector();
  const result = await detector.detectRelevantSessions(query, projectPath);

  if (result.relevantSessions.length === 0) {
    return {
      success: true,
      output: `没有找到与 "${query}" 相关的历史会话。\n\n建议：开始新会话。`,
      metadata: {
        action: 'search',
        query,
        suggestedAction: 'new',
        count: 0,
      },
    };
  }

  const output = formatSearchResult(result, query);

  return {
    success: true,
    output,
    metadata: {
      action: 'search',
      query,
      suggestedAction: result.suggestedAction,
      count: result.relevantSessions.length,
      sessions: result.relevantSessions.map((s) => ({
        id: s.sessionId,
        title: s.title,
        score: s.relevanceScore,
      })),
    },
  };
}

// ----------------------------------------------------------------------------
// Formatting Functions
// ----------------------------------------------------------------------------

/**
 * 格式化 Fork 结果
 */
function formatForkResult(
  context: InjectedContext,
  systemPromptFragment: string,
  userMessage: string
): string {
  const lines: string[] = [];

  lines.push('# 会话已 Fork');
  lines.push('');
  lines.push(`来源: **${context.fromSession.title}**`);
  lines.push(`时间: ${new Date(context.fromSession.createdAt).toLocaleDateString('zh-CN')}`);
  lines.push('');

  if (context.warnings.length > 0) {
    lines.push('## 注意事项');
    context.warnings.forEach((w) => lines.push(`- ${w}`));
    lines.push('');
  }

  lines.push('## 继承的上下文');
  lines.push('');
  lines.push(`- 关键消息: ${context.keyMessages.length} 条`);
  lines.push(`- 代码片段: ${context.codeContext.length} 个`);
  lines.push(`- 已做决策: ${context.decisions.length} 项`);
  lines.push('');

  if (context.decisions.length > 0) {
    lines.push('### 之前的决策');
    context.decisions.slice(0, 3).forEach((d) => lines.push(`- ${d}`));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('历史上下文已加载。你可以直接继续之前的工作，无需重复解释背景。');

  return lines.join('\n');
}

/**
 * 格式化会话列表
 */
function formatSessionList(sessions: RelevantSession[], title: string): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');

  sessions.forEach((session, index) => {
    const date = new Date(session.createdAt).toLocaleDateString('zh-CN');
    lines.push(`## ${index + 1}. ${session.title}`);
    lines.push(`- ID: \`${session.sessionId}\``);
    lines.push(`- 时间: ${date}`);
    lines.push(`- 消息数: ${session.messageCount}`);
    if (session.topics && session.topics.length > 0) {
      lines.push(`- 主题: ${session.topics.slice(0, 5).join(', ')}`);
    }
    if (session.projectPath) {
      lines.push(`- 项目: ${session.projectPath}`);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('要 Fork 某个会话，请使用: `fork_session { "session_id": "<会话ID>" }`');

  return lines.join('\n');
}

/**
 * 格式化搜索结果
 */
function formatSearchResult(result: ForkDetectionResult, query: string): string {
  const lines: string[] = [];

  lines.push(`# 与 "${query}" 相关的历史会话`);
  lines.push('');
  lines.push(`> ${result.reason}`);
  lines.push('');

  result.relevantSessions.forEach((session, index) => {
    const date = new Date(session.createdAt).toLocaleDateString('zh-CN');
    const score = (session.relevanceScore * 100).toFixed(0);

    lines.push(`## ${index + 1}. ${session.title}`);
    lines.push(`- **相关性**: ${score}%`);
    lines.push(`- **ID**: \`${session.sessionId}\``);
    lines.push(`- **时间**: ${date}`);
    lines.push(`- **消息数**: ${session.messageCount}`);
    if (session.topics && session.topics.length > 0) {
      lines.push(`- **主题**: ${session.topics.slice(0, 5).join(', ')}`);
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('');

  if (result.suggestedAction === 'fork') {
    const topSession = result.relevantSessions[0];
    lines.push(`**建议**: Fork 第一个高度相关的会话`);
    lines.push(`\`fork_session { "session_id": "${topSession.sessionId}" }\``);
  } else if (result.suggestedAction === 'ask') {
    lines.push('**建议**: 请选择一个会话进行 Fork，或开始新会话');
    lines.push('使用: `fork_session { "session_id": "<会话ID>" }`');
  } else {
    lines.push('**建议**: 相关性较低，建议开始新会话');
  }

  return lines.join('\n');
}

export default forkSessionTool;
