// ============================================================================
// nativeModelCheckpoint.withNativeModelOperation 单测：
// checkpoint 抛错（如 run 半注销 "Native Durable Run … is not active"）只降级为
// 不做 durable 记账，绝不顶替模型调用的真实结果/错误（2026-08-30 欠费报错被
// 内部 runId 错误覆盖事故的修复）。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const registryState = vi.hoisted(() => ({
  hasDurableOwner: vi.fn(),
  checkpointNativeModelOperation: vi.fn(),
}));

vi.mock('../../../src/host/app/applicationRunRegistry', () => ({
  getConfiguredApplicationRunRegistry: () => registryState,
}));

import { withNativeModelOperation } from '../../../src/host/agent/runtime/contextAssembly/nativeModelCheckpoint';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';

function makeCtx(): ContextAssemblyCtx {
  return {
    runtime: {
      runId: 'run-1',
      messages: [{ role: 'user', id: 'm1', content: 'hi' }],
      turn: { currentTurnId: 't1' },
      goalMode: null,
      control: { isCancelled: false, isInterrupted: false },
    },
  } as unknown as ContextAssemblyCtx;
}

const CONFIG = { provider: 'longcat', model: 'LongCat-2.0' } as Parameters<typeof withNativeModelOperation>[1];

describe('withNativeModelOperation（checkpoint 错误降级）', () => {
  beforeEach(() => {
    registryState.hasDurableOwner.mockReset().mockReturnValue(true);
    registryState.checkpointNativeModelOperation.mockReset();
  });

  it('checkpoint 全抛时模型正常结果原样返回', async () => {
    registryState.checkpointNativeModelOperation.mockRejectedValue(new Error('Native Durable Run run-1 is not active'));
    const result = await withNativeModelOperation(makeCtx(), CONFIG, new AbortController().signal, async () => 'model-answer');
    expect(result).toBe('model-answer');
  });

  it('checkpoint 全抛时模型原始错误原样透出（不被 runId 内部错误覆盖）', async () => {
    registryState.checkpointNativeModelOperation.mockRejectedValue(new Error('Native Durable Run run-1 is not active'));
    const authError = Object.assign(new Error('insufficient balance'), { statusCode: 402 });
    await expect(
      withNativeModelOperation(makeCtx(), CONFIG, new AbortController().signal, async () => { throw authError; }),
    ).rejects.toBe(authError);
  });

  it('checkpoint 正常时按生命周期记录（prepared/dispatched/succeeded）', async () => {
    registryState.checkpointNativeModelOperation.mockResolvedValue(undefined);
    await withNativeModelOperation(makeCtx(), CONFIG, new AbortController().signal, async () => 'ok');
    const statuses = registryState.checkpointNativeModelOperation.mock.calls.map((call) => call[0].status);
    expect(statuses).toEqual(['prepared', 'dispatched', 'succeeded']);
  });

  it('模型失败且 checkpoint 正常时记 failed settle', async () => {
    registryState.checkpointNativeModelOperation.mockResolvedValue(undefined);
    await expect(
      withNativeModelOperation(makeCtx(), CONFIG, new AbortController().signal, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    const statuses = registryState.checkpointNativeModelOperation.mock.calls.map((call) => call[0].status);
    expect(statuses).toEqual(['prepared', 'dispatched', 'failed']);
  });
});
