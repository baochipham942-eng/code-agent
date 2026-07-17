// ============================================================================
// promptUserInChat — 共享会话内交互 round-trip（Slice A 地基）
//
// 抽自 AskUserQuestion 的 USER_QUESTION_ASK/RESPONSE round-trip，供成本确认等
// tool 内部复用。覆盖：no-renderer 安全短路 / send shape+sessionId / 响应回灌 answered /
// 超时 timeout / abort。
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn());
const hasInteractiveRendererMock = vi.hoisted(() => vi.fn());
const ipcMainHandleMock = vi.hoisted(() => vi.fn());
// 捕获 once-guard 注册的 response handler（模块级单例，跨 test 只注册一次，
// 故用持久 ref 而非 mock.calls 计数）。mockImplementation 不被 clearAllMocks 清除。
const responseHandlerRef = vi.hoisted(() => ({ fn: undefined as undefined | ((e: unknown, r: unknown) => Promise<void>) }));
ipcMainHandleMock.mockImplementation((channel: string, fn: (e: unknown, r: unknown) => Promise<void>) => {
  if (channel === 'user-question:response') responseHandlerRef.fn = fn;
});

vi.mock('../../../../src/host/platform', () => ({
  ipcHost: { handle: ipcMainHandleMock },
  AppWindow: { getAllWindows: getAllWindowsMock, hasInteractiveRenderer: hasInteractiveRendererMock },
}));
vi.mock('../../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { promptUserInChat } from '../../../../src/host/tools/utils/userQuestionPrompt';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import type { UserQuestion, UserQuestionResponse } from '../../../../src/shared/contract';

const Q: UserQuestion[] = [
  {
    question: '要继续吗',
    header: '确认',
    options: [
      { label: '继续', description: '继续' },
      { label: '停止', description: '停止' },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindowsMock.mockReturnValue([]);
  hasInteractiveRendererMock.mockReturnValue(false);
});

describe('promptUserInChat', () => {
  it('无 renderer → status=no-renderer，不发 IPC（安全短路）', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(false);
    const r = await promptUserInChat(Q);
    expect(r.status).toBe('no-renderer');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('已 abort → status=aborted，不发 IPC', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await promptUserInChat(Q, { abortSignal: ctrl.signal });
    expect(r.status).toBe('aborted');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('有 renderer → 发 USER_QUESTION_ASK，shape={id,sessionId,questions,timestamp}，响应回灌 answered', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);

    const promise = promptUserInChat(Q, { sessionId: 'prompt-session', timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 5));

    // send 协议
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendMock.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.USER_QUESTION_ASK);
    expect(typeof payload.id).toBe('string');
    expect(payload.id).toMatch(/^q-\d+/);
    expect(payload.sessionId).toBe('prompt-session');
    expect(typeof payload.timestamp).toBe('number');
    expect(payload.questions).toEqual(Q);

    // 注册了 response handler（once-guard 单例，用持久 ref 捕获）
    expect(responseHandlerRef.fn).toBeDefined();

    // 模拟 renderer 回灌响应
    await responseHandlerRef.fn?.({}, { requestId: payload.id, answers: { 确认: '继续' } } as UserQuestionResponse);

    const r = await promise;
    expect(r.status).toBe('answered');
    expect(r.response?.answers).toEqual({ 确认: '继续' });
  });

  it('renderer 回传 declined → 立即解析为 status=declined', async () => {
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);

    const promise = promptUserInChat(Q, { timeoutMs: 5000 });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const request = sendMock.mock.calls[0][1];

    await responseHandlerRef.fn?.({}, { requestId: request.id, declined: true });

    const r = await promise;
    expect(r.status).toBe('declined');
  });

  it('超时 → status=timeout', async () => {
    vi.useFakeTimers();
    getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
    hasInteractiveRendererMock.mockReturnValue(true);

    const promise = promptUserInChat(Q, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    const r = await promise;
    expect(r.status).toBe('timeout');
    vi.useRealTimers();
  });
});
