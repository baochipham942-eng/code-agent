// ============================================================================
// AskUserQuestion (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/host/tools/planning/askUserQuestion.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / TIMEOUT_ERROR /
//   DOMAIN_ERROR
// - 行为保真（**重要：IPC 协议不变**）：
//   * IPC_CHANNELS.USER_QUESTION_ASK → renderer (request shape: {id, questions, timestamp})
//   * IPC_CHANNELS.USER_QUESTION_RESPONSE ← renderer (response shape: {requestId, answers})
//   * 1-4 questions 校验 / 每题 2-4 options 校验
//   * No window 时返回 CLI fallback（"用户未响应"模式）
//   * Desktop notification.notifyNeedsInput 透传
//   * INTERACTION_TIMEOUTS.USER_QUESTION 超时
//   * 输出 "User responses:\n[header]: answer" 格式 1:1
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type {
  UserQuestion,
} from '../../../../shared/contract';
import { promptUserInChat } from '../../utils/userQuestionPrompt';
import { askUserQuestionSchema as schema } from './askUserQuestion.schema';

function formatNoInteractiveUserOutput(questions: UserQuestion[]): string {
  const formatted = questions
    .map((q) => {
      const optionsStr = q.options
        .map((o, j) => `  ${j + 1}. ${o.label} - ${o.description}`)
        .join('\n');
      return `[${q.header}] ${q.question}\n${optionsStr}`;
    })
    .join('\n\n');

  return `[用户未响应 - CLI 模式无法交互]\n\n${formatted}\n\n⚠️ 用户无法回答问题。请不要自行选择选项，而是基于当前已知信息给出分析和建议，等待用户下一步指示。不要创建、修改或删除任何文件。`;
}

export async function executeAskUserQuestion(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const questions = args.questions as UserQuestion[];

  if (!Array.isArray(questions) || questions.length === 0) {
    return {
      ok: false,
      error: 'questions must be a non-empty array',
      code: 'INVALID_ARGS',
    };
  }
  if (questions.length > 4) {
    return {
      ok: false,
      error: 'Maximum 4 questions allowed',
      code: 'INVALID_ARGS',
    };
  }

  for (const q of questions) {
    if (!q.question || !q.header || !q.options) {
      return {
        ok: false,
        error: 'Each question must have question, header, and options',
        code: 'INVALID_ARGS',
      };
    }
    if (q.options.length < 2 || q.options.length > 4) {
      return {
        ok: false,
        error: 'Each question must have 2-4 options',
        code: 'INVALID_ARGS',
      };
    }
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const result = await promptUserInChat(questions, {
    sessionId: ctx.sessionId,
    abortSignal: ctx.abortSignal,
    notify: {
      title: '等待回答',
      body: questions[0]?.question || '请回答问题',
    },
  });

  if (result.status === 'no-renderer') {
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: formatNoInteractiveUserOutput(questions),
    };
  }
  if (result.status === 'aborted') {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }
  if (result.status === 'timeout') {
    return { ok: false, error: 'Question timeout - no response from user', code: 'DOMAIN_ERROR' };
  }
  if (result.status === 'declined' || result.response?.declined === true) {
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('AskUserQuestion declined', { requestId: result.response?.requestId });
    return {
      ok: true,
      output: 'User declined to answer.',
    };
  }

  const response = result.response;
  if (!response) {
    return { ok: false, error: 'Failed to get user response', code: 'DOMAIN_ERROR' };
  }

  const answerLines = Object.entries(response.answers).map(([header, answer]) => {
    const answerStr = Array.isArray(answer) ? answer.join(', ') : answer;
    return `[${header}]: ${answerStr}`;
  });

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('AskUserQuestion done', { requestId: response.requestId });

  return {
    ok: true,
    output: `User responses:\n${answerLines.join('\n')}`,
  };
}

class AskUserQuestionHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeAskUserQuestion(args, ctx, canUseTool, onProgress);
  }
}

export const askUserQuestionModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new AskUserQuestionHandler();
  },
};
