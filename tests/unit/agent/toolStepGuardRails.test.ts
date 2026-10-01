// ============================================================================
// toolStepGuardRails 单测（N-JEV-WARDEN-MOCK 审查 R2 #4：取消时跳过判官 + signal 传递）
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runToolStepGuardRails } from '../../../src/host/agent/runtime/toolStepGuardRails';
import { DoomLoopGuard } from '../../../src/host/agent/runtime/doomLoopGuard';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const fakeCtx = (control: Record<string, unknown>): RuntimeContext =>
  ({
    messages: [],
    turnTrace: {},
    control: {
      isCancelled: false,
      isInterrupted: false,
      runAbortController: undefined,
      forceFinalResponse: vi.fn(),
      ...control,
    },
  }) as unknown as RuntimeContext;

const fakeWarden = () => ({
  reviewToolStep: vi.fn().mockResolvedValue({ kind: 'none' }),
  interceptFinal: vi.fn().mockReturnValue(null),
});

const baseArgs = (ctx: RuntimeContext, warden: ReturnType<typeof fakeWarden>) => ({
  ctx,
  guard: new DoomLoopGuard(),
  warden: warden as never,
  toolCalls: [{ name: 'Bash', arguments: { command: 'ls' } }],
  iterations: 1,
  inject: vi.fn(),
  runTools: () => Promise.resolve('continue'),
});

describe('runToolStepGuardRails — JevWarden 取消语义（审查 R2 #4）', () => {
  it('已取消的工具步跳过判官（零调用），run 不等 Jev 请求', async () => {
    const warden = fakeWarden();
    const rails = await runToolStepGuardRails(baseArgs(fakeCtx({ isCancelled: true }), warden));
    expect(warden.reviewToolStep).not.toHaveBeenCalled();
    expect(rails).toEqual({ outcome: 'proceed', toolAction: 'continue' });
  });

  it('已中断的工具步同样跳过判官', async () => {
    const warden = fakeWarden();
    await runToolStepGuardRails(baseArgs(fakeCtx({ isInterrupted: true }), warden));
    expect(warden.reviewToolStep).not.toHaveBeenCalled();
  });

  it('未取消时 run abort signal 传进 warden 挂点输入', async () => {
    const warden = fakeWarden();
    const controller = new AbortController();
    await runToolStepGuardRails(baseArgs(fakeCtx({ runAbortController: controller }), warden));
    expect(warden.reviewToolStep).toHaveBeenCalledTimes(1);
    expect(warden.reviewToolStep.mock.calls[0][0].signal).toBe(controller.signal);
  });
});

describe('runToolStepGuardRails — steer epoch 透传（审查 R3）', () => {
  it('warden 挂点输入带活的 steerEpoch getter，反映 ctx.control 当前值', async () => {
    const warden = fakeWarden();
    const ctx = fakeCtx({ steerEpoch: 3 });
    await runToolStepGuardRails(baseArgs(ctx, warden));
    const readEpoch = warden.reviewToolStep.mock.calls[0][0].steerEpoch;
    expect(typeof readEpoch).toBe('function');
    expect(readEpoch()).toBe(3);
    (ctx.control as unknown as { steerEpoch: number }).steerEpoch = 4; // steer 后 getter 必须读到新值
    expect(readEpoch()).toBe(4);
  });
});

describe('runToolStepGuardRails — 工具执行期间 steer 整步跳过（审查 R5 #1）', () => {
  it('工具执行中 steer（epoch 变化）→ 判官零调用零裁决', async () => {
    const warden = fakeWarden();
    const ctx = fakeCtx({ steerEpoch: 0 });
    const rails = await runToolStepGuardRails({
      ...baseArgs(ctx, warden),
      runTools: () => {
        (ctx.control as unknown as { steerEpoch: number }).steerEpoch = 1; // 工具执行期间用户 steer
        return Promise.resolve('continue');
      },
    });
    expect(warden.reviewToolStep).not.toHaveBeenCalled();
    expect(rails).toEqual({ outcome: 'proceed', toolAction: 'continue' });
  });

  it('工具执行中未 steer（epoch 稳定）→ 照常送判官', async () => {
    const warden = fakeWarden();
    const ctx = fakeCtx({ steerEpoch: 0 });
    await runToolStepGuardRails(baseArgs(ctx, warden));
    expect(warden.reviewToolStep).toHaveBeenCalledTimes(1);
  });
});
