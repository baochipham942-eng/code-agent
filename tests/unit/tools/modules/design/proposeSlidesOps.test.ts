// ============================================================================
// ProposeSlidesOps（2b）—— agent 生成演示稿落预览 tab。
// 覆盖：topic 校验 / 权限 / abort / 免费大纲不弹成本确认 / illustrate 付费会话内确认
// fail-closed（取消不出图、不调 deck）/ 生成成功发 WORKSPACE_OPEN_PREVIEW。
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const sendMock = vi.hoisted(() => vi.fn());
const getAllWindowsMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
const deckMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/main/platform', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock },
}));
vi.mock('../../../../../src/main/tools/modules/design/generationCostConfirm', () => ({
  confirmGenerationCost: confirmMock,
}));
vi.mock('../../../../../src/main/ipc/workspaceSlidesExport', () => ({
  handleGenerateSlidesDeck: deckMock,
}));

import { proposeSlidesOpsModule } from '../../../../../src/main/tools/modules/design/proposeSlidesOps';

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
  confirmMock.mockResolvedValue(true);
  deckMock.mockResolvedValue({ filePath: '/Downloads/slides-x.pptx', slidesCount: 8, costCny: 0 });
});

async function run(args: Record<string, unknown>, ctx = makeCtx(), perm = allow) {
  const handler = await proposeSlidesOpsModule.createHandler();
  return handler.execute(args, ctx, perm);
}

describe('ProposeSlidesOps validation', () => {
  it('缺 topic → INVALID_ARGS', async () => {
    const r = await run({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
  });
  it('权限拒绝 → PERMISSION_DENIED', async () => {
    const r = await run({ topic: 'AI 产品' }, makeCtx(), deny);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED');
  });
  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await run({ topic: 'AI 产品' }, makeCtx({ abortSignal: ctrl.signal }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ABORTED');
  });
});

describe('ProposeSlidesOps 免费大纲路径', () => {
  it('illustrate 未开 → 不弹成本确认，直接生成并发预览', async () => {
    const r = await run({ topic: 'AI 产品经理转型', slidesCount: 8 });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(deckMock).toHaveBeenCalledTimes(1);
    // deck payload 不含 illustrate
    expect(deckMock.mock.calls[0][0].illustrate).toBeUndefined();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('演示稿');
    // 发了预览打开请求，带当前会话
    expect(sendMock).toHaveBeenCalledWith('workspace:open-preview', expect.objectContaining({ filePath: '/Downloads/slides-x.pptx', sessionId: 'sess-1' }));
  });
});

describe('ProposeSlidesOps 付费配图路径', () => {
  it('illustrate 开 + 用户取消 → 不生成、不花钱', async () => {
    confirmMock.mockResolvedValue(false);
    const r = await run({ topic: 'AI 产品经理转型', illustrate: true });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(deckMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('未确认');
  });

  it('illustrate 开 + 用户确认 → 带 illustrate 生成', async () => {
    deckMock.mockResolvedValue({ filePath: '/Downloads/s.pptx', slidesCount: 10, costCny: 0.56 });
    const r = await run({ topic: 'AI 产品经理转型', illustrate: true });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(deckMock).toHaveBeenCalledTimes(1);
    const payload = deckMock.mock.calls[0][0];
    expect(payload.illustrate).toBe(true);
    expect(typeof payload.imageModel).toBe('string');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toContain('¥0.56');
  });
});

describe('ProposeSlidesOps 生成失败', () => {
  it('deck 抛错 → DOMAIN_ERROR', async () => {
    deckMock.mockRejectedValue(new Error('LibreOffice 缺失'));
    const r = await run({ topic: 'AI 产品' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DOMAIN_ERROR');
  });
});
