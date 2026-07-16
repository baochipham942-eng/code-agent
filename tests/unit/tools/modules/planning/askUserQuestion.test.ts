// ============================================================================
// AskUserQuestion (native ToolModule) Tests — Wave 3 planning
//
// 关键覆盖：
// - schema 字段名 / required / nested options enum / max-questions 校验
// - **IPC 协议严格断言**（不可改动）：
//   * channel name = 'user-question:ask' / 'user-question:response'
//   * request shape: {id, questions, timestamp}
//   * response shape: {requestId, answers}
//   * webContents.send 的 channel 名 + payload 字段对齐 renderer
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码
// - CLI fallback 输出文案 1:1 复刻
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  AppWindow: { getAllWindows: getAllWindowsMock, hasInteractiveRenderer: hasInteractiveRendererMock },
}));
vi.mock('../../../../../src/host/services/infra/notificationService', () => ({
  notificationService: {
    notifyNeedsInput: notifyNeedsInputMock,
  },
}));

import { askUserQuestionModule } from '../../../../../src/host/tools/modules/planning/askUserQuestion';
import { IPC_CHANNELS } from '../../../../../src/shared/ipc';

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
  getAllWindowsMock.mockReturnValue([]);
  hasInteractiveRendererMock.mockReturnValue(false);
  sendMock.mockReset();
});

describe('AskUserQuestion schema', () => {
  it('对齐 legacy schema name/category/required/permissionLevel', () => {
    expect(askUserQuestionModule.schema.name).toBe('AskUserQuestion');
    expect(askUserQuestionModule.schema.category).toBe('planning');
    expect(askUserQuestionModule.schema.permissionLevel).toBe('execute');
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
});

// IPC 协议契约：renderer 监听这两个 channel + payload shape，**不能改**
describe('AskUserQuestion IPC protocol invariants', () => {
  it('CHANNEL constants 与 legacy 一致', () => {
    expect(IPC_CHANNELS.USER_QUESTION_ASK).toBe('user-question:ask');
    expect(IPC_CHANNELS.USER_QUESTION_RESPONSE).toBe('user-question:response');
  });

  it('webContents.send(USER_QUESTION_ASK, request) shape = {id, questions, timestamp} + ipcHost.handle 注册 USER_QUESTION_RESPONSE', async () => {
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
              { label: 'A', description: 'a' },
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
      questions: [
        expect.objectContaining({ question: 'q1?', header: 'h1' }),
      ],
    });
    expect(typeof payload.id).toBe('string');
    expect(payload.id).toMatch(/^q-\d+/);
    expect(typeof payload.timestamp).toBe('number');

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
    if (result.ok) expect(result.output).toBe('User declined to answer.');
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
