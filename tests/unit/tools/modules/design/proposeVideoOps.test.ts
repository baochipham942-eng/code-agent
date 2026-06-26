// ============================================================================
// ProposeVideoOps（2b）—— agent 在设计会话生成视频。
// 覆盖：参数校验 / 权限 / abort / 模型解析+时长 clamp / 会话区成本确认 fail-closed
// （取消不发出图请求、不花钱）/ applied·rejected·failed 三态回灌。
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const sendMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn());
const hasInteractiveRendererMock = vi.hoisted(() => vi.fn());
const ipcMainHandleMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
const responseHandlerRef = vi.hoisted(() => ({ fn: undefined as undefined | ((e: unknown, r: unknown) => Promise<void>) }));
ipcMainHandleMock.mockImplementation((channel: string, fn: (e: unknown, r: unknown) => Promise<void>) => {
  if (channel === 'canvas-video:response') responseHandlerRef.fn = fn;
});

vi.mock('../../../../../src/main/platform', () => ({
  ipcMain: { handle: ipcMainHandleMock },
  BrowserWindow: { getAllWindows: getAllWindowsMock, hasInteractiveRenderer: hasInteractiveRendererMock },
}));
vi.mock('../../../../../src/main/tools/modules/design/generationCostConfirm', () => ({
  confirmGenerationCost: confirmMock,
}));

import { proposeVideoOpsModule } from '../../../../../src/main/tools/modules/design/proposeVideoOps';

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
const allow: CanUseToolFn = async () => ({ allow: true });
const deny: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindowsMock.mockReturnValue([{ webContents: { send: sendMock } }]);
  hasInteractiveRendererMock.mockReturnValue(true);
  confirmMock.mockResolvedValue(true);
});

async function run(args: Record<string, unknown>, ctx = makeCtx(), perm = allow) {
  const handler = await proposeVideoOpsModule.createHandler();
  return handler.execute(args, ctx, perm);
}

describe('ProposeVideoOps validation', () => {
  it('非法 mode → INVALID_ARGS', async () => {
    const r = await run({ mode: 'xxx' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });
  it('t2v 缺 prompt → INVALID_ARGS', async () => {
    const r = await run({ mode: 't2v' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });
  it('i2v 缺 baseNodeId → INVALID_ARGS', async () => {
    const r = await run({ mode: 'i2v' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });
  it('权限拒绝 → PERMISSION_DENIED', async () => {
    const r = await run({ mode: 't2v', prompt: 'a cat' }, makeCtx(), deny);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED');
  });
  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await run({ mode: 't2v', prompt: 'a cat' }, makeCtx({ abortSignal: ctrl.signal }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ABORTED');
  });
});

describe('ProposeVideoOps 成本确认 fail-closed', () => {
  it('用户未确认成本 → 不发出图请求、不花钱', async () => {
    confirmMock.mockResolvedValue(false);
    const r = await run({ mode: 't2v', prompt: 'a cat' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('未确认');
    // 关键：没有发起 CANVAS_VIDEO_ASK（不进 renderer 出图路径）
    expect(sendMock).not.toHaveBeenCalledWith('canvas-video:ask', expect.anything());
  });
});

describe('ProposeVideoOps 出图请求', () => {
  it('确认后发 CANVAS_VIDEO_ASK：模型解析+时长 clamp，applied 回灌成功', async () => {
    // 非法 model + 越界 durationSec → 回退 wan2.7-t2v + clamp 到 15s（max）
    const promise = run({ mode: 't2v', prompt: 'a cat', model: 'bogus', durationSec: 99 });
    await new Promise((r) => setTimeout(r, 5));

    const askCall = sendMock.mock.calls.find((c) => c[0] === 'canvas-video:ask');
    expect(askCall).toBeDefined();
    const req = askCall![1];
    expect(req.model).toBe('wan2.7-t2v');
    expect(req.durationSec).toBe(15);
    expect(req.mode).toBe('t2v');
    expect(req.sessionId).toBe('sess-1');
    expect(typeof req.requestId).toBe('string');

    expect(responseHandlerRef.fn).toBeDefined();
    await responseHandlerRef.fn?.({}, { requestId: req.requestId, status: 'applied', costCny: 0.7, durationSec: 15 });
    const r = await promise;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('已生成');
  });

  it('属主隔离 rejected → ok 但说明被隔离', async () => {
    const promise = run({ mode: 't2v', prompt: 'a cat' });
    await new Promise((r) => setTimeout(r, 5));
    const req = sendMock.mock.calls.find((c) => c[0] === 'canvas-video:ask')![1];
    await responseHandlerRef.fn?.({}, { requestId: req.requestId, status: 'rejected', error: '画布属另一会话' });
    const r = await promise;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('隔离');
  });

  it('出图失败 failed → DOMAIN_ERROR', async () => {
    const promise = run({ mode: 't2v', prompt: 'a cat' });
    await new Promise((r) => setTimeout(r, 5));
    const req = sendMock.mock.calls.find((c) => c[0] === 'canvas-video:ask')![1];
    await responseHandlerRef.fn?.({}, { requestId: req.requestId, status: 'failed', error: '余额不足' });
    const r = await promise;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DOMAIN_ERROR');
      expect(r.error).toContain('余额不足');
    }
  });
});
