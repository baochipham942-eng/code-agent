// ============================================================================
// AskUserQuestion (native ToolModule) Tests — Wave 3 planning
//
// 关键覆盖：
// - schema 字段名 / required / nested options enum / max-questions 校验
// - **IPC 协议严格断言**（不可改动）：
//   * channel name = 'user-question:ask' / 'user-question:response'
//   * request shape: {id, sessionId?, questions, timestamp}
//   * response shape: {requestId, answers}
//   * webContents.send 的 channel 名 + payload 字段对齐 renderer
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码
// - CLI fallback 输出文案 1:1 复刻
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasInteractiveUi as realHasInteractiveUi,
  setBrowserWindowInteractionProbe,
} from '../../../../../src/host/platform/windowBridge';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

// Hoisted mocks: ipcHost.handle / AppWindow.getAllWindows / webContents.send
const ipcMainHandleMock = vi.hoisted(() => vi.fn());
const sendMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn());
const hasInteractiveRendererMock = vi.hoisted(() => vi.fn());
const notifyNeedsInputMock = vi.hoisted(() => vi.fn());
const responseHandlerRef = vi.hoisted(() => ({
  fn: undefined as undefined | ((event: unknown, response: unknown) => Promise<void>),
}));

ipcMainHandleMock.mockImplementation(
  (channel: string, handler: (event: unknown, response: unknown) => Promise<void>) => {
    if (channel === 'user-question:response') responseHandlerRef.fn = handler;
  },
);

vi.mock('../../../../../src/host/platform', () => ({
  ipcHost: { handle: ipcMainHandleMock },
  hasInteractiveUi: hasInteractiveRendererMock,
  AppWindow: { getAllWindows: getAllWindowsMock, hasInteractiveRenderer: hasInteractiveRendererMock },
}));
vi.mock('../../../../../src/host/services/infra/notificationService', () => ({
  notificationService: {
    notifyNeedsInput: notifyNeedsInputMock,
  },
}));

import { askUserQuestionModule } from '../../../../../src/host/tools/modules/planning/askUserQuestion';
import {
  clearAskUserQuestionReplay,
  lookupAskUserQuestionReplay,
  recordAskUserQuestionAnswer,
} from '../../../../../src/host/tools/modules/planning/askUserQuestionReplay';
import type { UserQuestion } from '../../../../../src/shared/contract';
import { INTERACTION_TIMEOUTS } from '../../../../../src/shared/constants';
import {
  beginVoiceQuestionSession,
  canOfferVoiceQuestion,
  cancelVoiceQuestion,
  endVoiceQuestionSession,
  offerVoiceQuestion,
} from '../../../../../src/host/services/voice/voiceQuestionBridge';
import { registerUserQuestionRoute } from '../../../../../src/host/services/capabilities/hostCapabilityPorts';
import { IPC_CHANNELS } from '../../../../../src/shared/ipc';

let cleanupVoiceQuestionRoute: (() => void | Promise<void>) | undefined;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  cleanupVoiceQuestionRoute = registerUserQuestionRoute({
    canOffer: canOfferVoiceQuestion,
    offer: offerVoiceQuestion,
    cancel: cancelVoiceQuestion,
  });
  getAllWindowsMock.mockReturnValue([]);
  hasInteractiveRendererMock.mockReturnValue(false);
  sendMock.mockReset();
});

afterEach(() => {
  void cleanupVoiceQuestionRoute?.();
  cleanupVoiceQuestionRoute = undefined;
  vi.useRealTimers();
  setBrowserWindowInteractionProbe(null);
});

describe('AskUserQuestion schema', () => {
  it('对齐 legacy schema name/category/required/permissionLevel', () => {
    expect(askUserQuestionModule.schema.name).toBe('AskUserQuestion');
    expect(askUserQuestionModule.schema.category).toBe('planning');
    expect(askUserQuestionModule.schema.permissionLevel).toBe('execute');
    expect(askUserQuestionModule.schema.requiresPermission).toBe(false);
    expect(askUserQuestionModule.schema.inputSchema.required).toEqual(['questions']);
  });

  it('questions item shape: question/header/options/multiSelect 字段存在', () => {
    const props = askUserQuestionModule.schema.inputSchema.properties as Record<
      string,
      { items?: { properties?: Record<string, unknown> } }
    >;
    expect(props.questions.items).toBeDefined();
    const itemProps = (props.questions.items?.properties || {}) as Record<string, unknown>;
    expect(itemProps.question).toBeDefined();
    expect(itemProps.header).toBeDefined();
    expect(itemProps.options).toBeDefined();
    expect(itemProps.multiSelect).toBeDefined();
  });

  it('工具描述禁止把写回审批当成表单收集前置步骤', () => {
    expect(askUserQuestionModule.schema.description).toMatchInlineSnapshot(
      `"Ask branching decisions only (A/B/proceed). Never collect approval-gated writeback fields. Call the write tool with values/defaults; the approval card is the edit point. “Create meeting now” means tmeetMeetingCreate directly."`,
    );
  });
});

// IPC 协议契约：renderer 监听这两个 channel + payload shape，**不能改**
describe('AskUserQuestion IPC protocol invariants', () => {
  it('CHANNEL constants 与 legacy 一致', () => {
    expect(IPC_CHANNELS.USER_QUESTION_ASK).toBe('user-question:ask');
    expect(IPC_CHANNELS.USER_QUESTION_RESPONSE).toBe('user-question:response');
  });

  it('webContents.send(USER_QUESTION_ASK, request) shape = {id, sessionId, questions, timestamp} + ipcHost.handle 注册 USER_QUESTION_RESPONSE', async () => {
    const window = { webContents: { send: sendMock } };
    getAllWindowsMock.mockReturnValue([window]);
    hasInteractiveRendererMock.mockReturnValue(true);

    const handler = await askUserQuestionModule.createHandler();

    // 不等待响应（手动 abort 让 promise reject）
    const ctrl = new AbortController();
    const ctx = makeCtx({ abortSignal: ctrl.signal });
    const promise = handler.execute(
      {
        questions: [
          {
            question: 'q1?',
            header: 'h1',
            options: [
              { label: 'A (推荐)', description: 'a' },
              { label: 'B', description: 'b' },
            ],
          },
        ],
      },
      ctx,
      allowAll,
    );
    // 等 IPC 调用完成（也就是 send 被调用）后拒绝继续
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    // 让 timeout 早些 reject
    promise.catch(() => void 0);

    // ── send shape (LLM/renderer 协议) ──
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendMock.mock.calls[0];
    expect(channel).toBe('user-question:ask');
    expect(channel).toBe(IPC_CHANNELS.USER_QUESTION_ASK);
    expect(payload).toMatchObject({
      sessionId: 'sess-1',
      questions: [
        expect.objectContaining({ question: 'q1?', header: 'h1' }),
      ],
    });
    expect(typeof payload.id).toBe('string');
    expect(payload.id).toMatch(/^q-\d+/);
    expect(typeof payload.timestamp).toBe('number');
    expect(payload.questions[0].options).toEqual([
      { label: 'A', description: 'a', recommended: true },
      { label: 'B', description: 'b' },
    ]);

    // ── ipcHost.handle 注册 response channel ──
    // 注：handlerRegistered 是 module 级 once-guard。第一次执行时注册，
    // 后续执行不再重新注册（避免 ipcHost 报错）。所以这里只断言 channel 名正确。
    const handleCalls = ipcMainHandleMock.mock.calls.filter(
      (c) => c[0] === 'user-question:response',
    );
    if (handleCalls.length > 0) {
      expect(handleCalls[0][0]).toBe(IPC_CHANNELS.USER_QUESTION_RESPONSE);
    }
    // 即使本轮没调用 handle（once 已 fire），module-level guard 必须保证幂等：
    // 至少历史上调过一次（ipcMainHandleMock 累计调用次数）
    const allHandleCalls = ipcMainHandleMock.mock.calls;
    const responseChannelCalls = allHandleCalls.filter(
      (c) => c[0] === IPC_CHANNELS.USER_QUESTION_RESPONSE,
    );
    expect(responseChannelCalls.length).toBeLessThanOrEqual(1);
  });
});

describe('AskUserQuestion validation', () => {
  it('questions 不是数组 → INVALID_ARGS', async () => {
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute({ questions: 'foo' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('questions 数组为空 → INVALID_ARGS', async () => {
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute({ questions: [] }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('questions 超 4 → INVALID_ARGS', async () => {
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute(
      {
        questions: new Array(5).fill({
          question: 'q',
          header: 'h',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        }),
      },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Maximum 4 questions');
    }
  });

  it('question 缺 header → INVALID_ARGS', async () => {
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute(
      { questions: [{ question: 'q', options: [{}, {}] }] },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('question, header, and options');
    }
  });

  it('options 不在 [2,4] 范围 → INVALID_ARGS', async () => {
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute(
      {
        questions: [
          { question: 'q', header: 'h', options: [{ label: 'only', description: 'one' }] },
        ],
      },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('2-4 options');
    }
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute(
      {
        questions: [
          {
            question: 'q',
            header: 'h',
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
          },
        ],
      },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute(
      {
        questions: [
          {
            question: 'q',
            header: 'h',
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
          },
        ],
      },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });
});

describe('AskUserQuestion CLI fallback', () => {
  it('无 window → 输出 "用户未响应 - CLI 模式" 文案 1:1', async () => {
    getAllWindowsMock.mockReturnValue([]);
    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute(
      {
        questions: [
          {
            question: '选哪个',
            header: '选',
            options: [
              { label: 'A', description: 'aaa' },
              { label: 'B', description: 'bbb' },
            ],
          },
        ],
      },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('[用户未响应 - CLI 模式无法交互]');
      expect(result.output).toContain('[选] 选哪个');
      expect(result.output).toContain('1. A - aaa');
      expect(result.output).toContain('2. B - bbb');
      expect(result.output).toContain('⚠️ 用户无法回答问题');
      expect(result.output).toContain('不要创建、修改或删除任何文件');
      expect(result.meta).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('无头规则'),
        awaitingUserInput: true,
      });
    }
  });

  it('有 webServer mock window 但没有 renderer 连接 → 不等待 IPC，直接 fallback', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(false);

    const handler = await askUserQuestionModule.createHandler();
    const result = await handler.execute(
      {
        questions: [
          {
            question: '要继续吗',
            header: '确认',
            options: [
              { label: '继续', description: '继续当前操作' },
              { label: '停止', description: '停下等待' },
            ],
          },
        ],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.output).toContain('[用户未响应 - CLI 模式无法交互]');
      expect(result.output).toContain('[确认] 要继续吗');
      expect(result.meta).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('无头规则'),
        awaitingUserInput: true,
      });
    }
  });
});

describe('AskUserQuestion renderer response', () => {
  const questions = [
    {
      question: '要继续吗',
      header: '确认',
      options: [
        { label: '继续', description: '继续当前操作' },
        { label: '停止', description: '停下等待' },
      ],
    },
  ];

  it('交互环境挂 10 分钟不失败，仍可作答回传', async () => {
    vi.useFakeTimers();
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    setBrowserWindowInteractionProbe(() => true);
    hasInteractiveRendererMock.mockImplementation(realHasInteractiveUi);

    const handler = await askUserQuestionModule.createHandler();
    const promise = handler.execute({ questions }, makeCtx(), allowAll);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(notifyNeedsInputMock).toHaveBeenCalledTimes(1);

    const marker = Symbol('pending');
    await expect(Promise.race([promise, Promise.resolve(marker)])).resolves.toBe(marker);
    const request = sendMock.mock.calls[0]?.[1];
    await responseHandlerRef.fn?.({}, { requestId: request.id, answers: { 确认: '继续' } });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      output: 'User responses:\n[确认]: 继续',
    });
  });

  it('无 renderer 的等待路径 5 分钟失败，reason 明确包含超时', async () => {
    vi.useFakeTimers();
    beginVoiceQuestionSession({
      neoSessionId: 'headless-question-session',
      dismiss: vi.fn(),
      speak: vi.fn(),
    });
    try {
      const handler = await askUserQuestionModule.createHandler();
      const promise = handler.execute(
        { questions },
        makeCtx({ sessionId: 'headless-question-session' }),
        allowAll,
      );
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('USER_INPUT_TIMEOUT');
        expect(result.error).toContain('等你决定超过 5 分钟');
        expect(result.meta).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('无头规则'),
          awaitingUserInput: true,
        });
      }
    } finally {
      endVoiceQuestionSession('headless-question-session');
    }
  });

  it('declined 响应返回明确结果，让 agent loop 立即继续', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);

    const handler = await askUserQuestionModule.createHandler();
    const promise = handler.execute({ questions }, makeCtx(), allowAll);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const request = sendMock.mock.calls[0][1];

    await responseHandlerRef.fn?.({}, { requestId: request.id, declined: true });

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output.toLowerCase();
      expect(output).toContain('continue with the information you already have');
      expect(output).toContain('make reasonable defaults');
      expect(output).toContain('state your assumptions');
      expect(output).toContain('do not ask the same question again');
      expect(result.meta?.awaitingUserInput).not.toBe(true);
    }
  });

  it('declined 响应附 reason 时拼进 output，让模型看到取消原因', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);

    const handler = await askUserQuestionModule.createHandler();
    const promise = handler.execute({ questions }, makeCtx(), allowAll);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const request = sendMock.mock.calls[0][1];

    await responseHandlerRef.fn?.(
      {},
      { requestId: request.id, declined: true, reason: '现在不方便回答，稍后再说' },
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('continue with the information you already have');
      expect(result.output).toContain('do not ask the same question again');
      expect(result.output).toContain('Reason: 现在不方便回答，稍后再说');
      expect(result.meta?.awaitingUserInput).not.toBe(true);
    }
  });

  it('交互环境 24h 停车超时 meta 含 awaitingUserInput，保留 denied 与超时码', async () => {
    vi.useFakeTimers();
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    setBrowserWindowInteractionProbe(() => true);
    hasInteractiveRendererMock.mockImplementation(realHasInteractiveUi);

    const handler = await askUserQuestionModule.createHandler();
    const promise = handler.execute({ questions }, makeCtx(), allowAll);
    await vi.advanceTimersByTimeAsync(INTERACTION_TIMEOUTS.PARKED_APPROVAL);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('USER_INPUT_TIMEOUT');
      expect(result.error).toContain('等待用户回答超过 24 小时');
      expect(result.meta).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('停车请求已按安全兜底拒绝'),
        awaitingUserInput: true,
      });
    }
  });

  it('旧 answers-only 响应仍按 answered 处理', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);

    const handler = await askUserQuestionModule.createHandler();
    const promise = handler.execute({ questions }, makeCtx(), allowAll);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const request = sendMock.mock.calls[0][1];

    await responseHandlerRef.fn?.({}, { requestId: request.id, answers: { 确认: '继续' } });

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe('User responses:\n[确认]: 继续');
  });
});

// ============================================================================
// 同轮重复问句回放（N-ASKUSER-REPEAT-REPLAY）
// ① 同轮同问第二次：无 send（提问事件）、无 canUseTool（审批），输出=上次答案+回放标记
// ② 选项顺序/空白/标点/大小写/全半角差异 → 同问；选项集合不同（含新增选项）→ 照弹
// ③ 跨轮/跨会话不回放；clearAskUserQuestionReplay（run 结束清空）后照弹
// ============================================================================
describe('AskUserQuestion 同轮重复问句回放', () => {
  const replayQuestions: UserQuestion[] = [
    {
      question: '要继续吗？',
      header: '确认',
      options: [
        { label: '继续', description: '继续当前操作' },
        { label: '停止', description: '停下等待' },
      ],
    },
  ];

  beforeEach(() => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);
  });

  async function executeAndAnswer(
    ctx: ToolContext,
    questions: UserQuestion[],
    callIndex: number,
    canUseTool: CanUseToolFn = allowAll,
  ) {
    const handler = await askUserQuestionModule.createHandler();
    const promise = handler.execute({ questions }, ctx, canUseTool);
    await vi.waitFor(() => expect(sendMock.mock.calls.length).toBeGreaterThan(callIndex));
    const request = sendMock.mock.calls[callIndex][1];
    await responseHandlerRef.fn?.({}, { requestId: request.id, answers: { 确认: '继续' } });
    return promise;
  }

  it('同轮同问第二次不产生提问事件与审批，工具结果=上次答案+回放标记', async () => {
    const ctx = makeCtx({ turnId: 'turn-replay-1' });
    const canUseTool = vi.fn(allowAll);

    const first = await executeAndAnswer(ctx, replayQuestions, 0, canUseTool);
    expect(first).toMatchObject({ ok: true, output: 'User responses:\n[确认]: 继续' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(canUseTool).toHaveBeenCalledTimes(1);

    const handler = await askUserQuestionModule.createHandler();
    const second = await handler.execute({ questions: replayQuestions }, ctx, canUseTool);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.output).toContain('User responses:\n[确认]: 继续');
      expect(second.output).toContain('你这轮已答过');
    }
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it('问句只差选项顺序/空白/标点视为同问，直接回放', async () => {
    const ctx = makeCtx({ turnId: 'turn-replay-2' });
    await executeAndAnswer(ctx, replayQuestions, 0);

    const reordered: UserQuestion[] = [
      {
        question: ' 要继续吗?',
        header: '确认 ',
        options: [
          { label: '停止 ', description: '停下等待' },
          { label: '继续', description: ' 继续当前操作' },
        ],
      },
    ];
    const handler = await askUserQuestionModule.createHandler();
    const second = await handler.execute({ questions: reordered }, ctx, allowAll);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output).toContain('你这轮已答过');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('选项集合不同（新增选项）视为语义不同，照弹', async () => {
    const ctx = makeCtx({ turnId: 'turn-replay-3' });
    await executeAndAnswer(ctx, replayQuestions, 0);

    const withNewOption: UserQuestion[] = [
      {
        ...replayQuestions[0],
        options: [
          ...replayQuestions[0].options,
          { label: '稍后', description: '待会再定' },
        ],
      },
    ];
    const second = await executeAndAnswer(ctx, withNewOption, 1);
    expect(second).toMatchObject({ ok: true, output: 'User responses:\n[确认]: 继续' });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('跨轮不回放', async () => {
    await executeAndAnswer(makeCtx({ turnId: 'turn-replay-4a' }), replayQuestions, 0);

    const nextTurnCtx = makeCtx({ turnId: 'turn-replay-4b' });
    const second = await executeAndAnswer(nextTurnCtx, replayQuestions, 1);
    expect(second).toMatchObject({ ok: true, output: 'User responses:\n[确认]: 继续' });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('跨会话不回放', async () => {
    await executeAndAnswer(makeCtx({ turnId: 'turn-replay-5' }), replayQuestions, 0);

    const otherSessionCtx = makeCtx({ sessionId: 'sess-2', turnId: 'turn-replay-5' });
    const second = await executeAndAnswer(otherSessionCtx, replayQuestions, 1);
    expect(second).toMatchObject({ ok: true, output: 'User responses:\n[确认]: 继续' });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('生产形状：两次调用 turnId 不同、runId 相同（跨模型迭代）仍命中回放', async () => {
    // streamHandler.setupIteration 每次迭代重铸 turnId（generateMessageId → beginTurn），
    // 模型必然先拿答案、下一迭代才重问——作用域必须是 runId 而不是 turnId。
    const first = await executeAndAnswer(
      makeCtx({ runId: 'run-prod-1', turnId: 'iter-1' }),
      replayQuestions,
      0,
    );
    expect(first).toMatchObject({ ok: true, output: 'User responses:\n[确认]: 继续' });

    const handler = await askUserQuestionModule.createHandler();
    const second = await handler.execute(
      { questions: replayQuestions },
      makeCtx({ runId: 'run-prod-1', turnId: 'iter-2' }),
      allowAll,
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.output).toContain('User responses:\n[确认]: 继续');
      expect(second.output).toContain('你这轮已答过');
    }
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('跨 run 不回放（turnId 相同、runId 不同照弹）', async () => {
    await executeAndAnswer(makeCtx({ runId: 'run-a', turnId: 'iter-1' }), replayQuestions, 0);

    const second = await executeAndAnswer(makeCtx({ runId: 'run-b', turnId: 'iter-1' }), replayQuestions, 1);
    expect(second).toMatchObject({ ok: true, output: 'User responses:\n[确认]: 继续' });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('选项只有 label 没有 description：正常弹卡不抛错，且可回放', async () => {
    const noDescQuestions = [
      {
        question: '选哪个',
        header: '选',
        options: [{ label: '甲' }, { label: '乙' }],
      },
    ] as unknown as UserQuestion[];
    const ctx = makeCtx({ runId: 'run-nodesc', turnId: 'iter-1' });
    const first = await executeAndAnswer(ctx, noDescQuestions, 0);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.output).toContain('User responses:');

    const handler = await askUserQuestionModule.createHandler();
    const second = await handler.execute({ questions: noDescQuestions }, ctx, allowAll);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output).toContain('你这轮已答过');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('run 结束清空缓存后同问照弹', async () => {
    const ctx = makeCtx({ turnId: 'turn-replay-6' });
    await executeAndAnswer(ctx, replayQuestions, 0);

    clearAskUserQuestionReplay('sess-1');

    const second = await executeAndAnswer(ctx, replayQuestions, 1);
    expect(second).toMatchObject({ ok: true, output: 'User responses:\n[确认]: 继续' });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('无 turnId/runId 的 ctx 不缓存也不回放（保守照弹）', async () => {
    const ctx = makeCtx();
    await executeAndAnswer(ctx, replayQuestions, 0);

    const handler = await askUserQuestionModule.createHandler();
    const promise = handler.execute({ questions: replayQuestions }, ctx, allowAll);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    const request = sendMock.mock.calls[1][1];
    await responseHandlerRef.fn?.({}, { requestId: request.id, answers: { 确认: '继续' } });
    const second = await promise;
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output).not.toContain('你这轮已答过');
  });
});

// 归一化语义走行为面钉：record 写入后 lookup 命中=同问、未命中=不同问
// （buildAskUserQuestionReplayKey 是模块内私有，仓规 §5.9 不为测试开 export）。
describe('AskUserQuestion 回放归一化语义（record/lookup 行为面）', () => {
  const REPLAY_OUTPUT = 'User responses:\n[h]: a';

  function recordThenLookup(
    turnId: string,
    recorded: UserQuestion[],
    queried: UserQuestion[],
  ): string | undefined {
    const ctx = makeCtx({ turnId });
    recordAskUserQuestionAnswer(ctx, recorded, REPLAY_OUTPUT);
    return lookupAskUserQuestionReplay(ctx, queried);
  }

  it('大小写/全半角/标点/空白/选项顺序不影响同问判定', () => {
    const hit = recordThenLookup(
      'turn-key-1',
      [
        {
          question: 'Deploy NOW？',
          header: 'H',
          options: [
            { label: 'Ａ', description: 'x' },
            { label: 'b', description: 'y' },
          ],
        },
      ],
      [
        {
          question: 'deploy now?',
          header: 'h ',
          options: [
            { label: 'B', description: 'y' },
            { label: 'a', description: 'x' },
          ],
        },
      ],
    );
    expect(hit).toBeDefined();
    expect(hit).toContain(REPLAY_OUTPUT);
    expect(hit).toContain('你这轮已答过');
  });

  it('有无标点不算差异（剥标点而非仅 NFKC 归一）', () => {
    const hit = recordThenLookup(
      'turn-key-2',
      [
        {
          question: '部署到生产环境，好吗？',
          header: 'h',
          options: [
            { label: 'a', description: 'x' },
            { label: 'b', description: 'y' },
          ],
        },
      ],
      [
        {
          question: '部署到生产环境好吗',
          header: 'h',
          options: [
            { label: 'a', description: 'x' },
            { label: 'b', description: 'y' },
          ],
        },
      ],
    );
    expect(hit).toBeDefined();
  });

  it('选项集合不同（含新增/替换选项）视为不同问，不回放', () => {
    const base: UserQuestion[] = [
      {
        question: 'q',
        header: 'h',
        options: [
          { label: 'a', description: 'x' },
          { label: 'b', description: 'y' },
        ],
      },
    ];
    const added: UserQuestion[] = [
      {
        question: 'q',
        header: 'h',
        options: [
          { label: 'a', description: 'x' },
          { label: 'b', description: 'y' },
          { label: 'c', description: 'z' },
        ],
      },
    ];
    const changed: UserQuestion[] = [
      {
        question: 'q',
        header: 'h',
        options: [
          { label: 'a', description: 'x' },
          { label: 'c', description: 'y' },
        ],
      },
    ];
    expect(recordThenLookup('turn-key-3a', base, added)).toBeUndefined();
    expect(recordThenLookup('turn-key-3b', base, changed)).toBeUndefined();
  });

  it('multiSelect 不同视为不同问（语义差异照弹）', () => {
    const single: UserQuestion[] = [
      {
        question: 'q',
        header: 'h',
        options: [
          { label: 'a', description: 'x' },
          { label: 'b', description: 'y' },
        ],
      },
    ];
    const multi: UserQuestion[] = [
      {
        question: 'q',
        header: 'h',
        multiSelect: true,
        options: [
          { label: 'a', description: 'x' },
          { label: 'b', description: 'y' },
        ],
      },
    ];
    expect(recordThenLookup('turn-key-4', single, multi)).toBeUndefined();
  });
});
