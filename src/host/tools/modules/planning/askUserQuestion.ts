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
//   * 无交互 renderer 的等待路径保留 INTERACTION_TIMEOUTS.USER_QUESTION 超时
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
import {
  ASK_USER_QUESTION_DECLINED_OUTPUT,
  ASK_USER_QUESTION_UNANSWERED_PREFIX,
} from '../../../../shared/contract/askUserQuestion';
import { promptUserInChat } from '../../utils/userQuestionPrompt';
import {
  lookupAskUserQuestionReplay,
  recordAskUserQuestionAnswer,
} from './askUserQuestionReplay';
import { askUserQuestionSchema as schema } from './askUserQuestion.schema';
import {
  deniedDecisionMetadata,
  USER_INPUT_TIMEOUT_CODE,
} from '../../../permissions/userDecision';

function formatNoInteractiveUserOutput(questions: UserQuestion[]): string {
  const formatted = questions
    .map((q) => {
      const optionsStr = q.options
        .map((o, j) => `  ${j + 1}. ${o.label} - ${o.description}`)
        .join('\n');
      return `[${q.header}] ${q.question}\n${optionsStr}`;
    })
    .join('\n\n');

  return `${ASK_USER_QUESTION_UNANSWERED_PREFIX}\n\n${formatted}\n\n⚠️ 用户无法回答问题。请不要自行选择选项，而是基于当前已知信息给出分析和建议，等待用户下一步指示。不要创建、修改或删除任何文件。`;
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

  // 取消检查必须在回放命中之前：已取消的重复调用要返回 ABORTED，不能拿旧答案报 ok。
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  // 同 run 字面重复问句：直接回放上次答案，不产生审批与提问事件（N-ASKUSER-REPEAT-REPLAY）。
  const replayedOutput = lookupAskUserQuestionReplay(ctx, questions);
  if (replayedOutput !== undefined) {
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('AskUserQuestion replayed same-turn answer', { sessionId: ctx.sessionId });
    return { ok: true, output: replayedOutput };
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
    const reason = '当前运行环境没有可投递的交互界面，用户问题已按无头规则安全拒绝。';
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: formatNoInteractiveUserOutput(questions),
      // awaitingUserInput 是「问句未答冻结」的引擎信号（toolExecutionEngine 消费）：
      // 输出文案里的「不要创建、修改或删除任何文件」不能只指望模型读懂人话。
      meta: { ...deniedDecisionMetadata(reason), awaitingUserInput: true },
    };
  }
  if (result.status === 'aborted') {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }
  if (result.status === 'timeout') {
    const reason = result.reason ?? '等待用户决定超时，已按无头规则安全拒绝。';
    return {
      ok: false,
      error: reason,
      code: USER_INPUT_TIMEOUT_CODE,
      // 有界面但用户超时没答：与无头无人应答同属「问句未答」，冻结非 read 工具。
      // declined（用户明确跳过、文案让模型按默认继续）不置此位。
      meta: { ...deniedDecisionMetadata(reason), awaitingUserInput: true },
    };
  }
  if (result.status === 'declined' || result.response?.declined === true) {
    onProgress?.({ stage: 'completing', percent: 100 });
    const reason = result.response?.declined ? result.response.reason : undefined;
    ctx.logger.debug('AskUserQuestion declined', { requestId: result.response?.requestId, reason });
    return {
      ok: true,
      output: reason
        ? `${ASK_USER_QUESTION_DECLINED_OUTPUT} Reason: ${reason}`
        : ASK_USER_QUESTION_DECLINED_OUTPUT,
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

  const output = `User responses:\n${answerLines.join('\n')}`;
  // 多问题卡允许只提交部分 header（Companion 协议）：残缺答案不缓存，
  // 本次正常返回，但下轮同问必须照弹，不能回放不完整结果。
  const allAnswered = questions.every((q) => {
    const answer = response.answers[q.header];
    return Array.isArray(answer)
      ? answer.some((item) => item.trim().length > 0)
      : typeof answer === 'string' && answer.trim().length > 0;
  });
  if (allAnswered) recordAskUserQuestionAnswer(ctx, questions, output);
  return {
    ok: true,
    output,
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
