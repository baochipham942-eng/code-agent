// ============================================================================
// useAgent.streamSnapshotRehydrate.test.ts — N-STREAMSNAPSHOT-LOG-SPAM
//
// 钉住两件事：
// 1. AGENT_STREAM_SNAPSHOT_REQUIRED → switchSession(force) 的会话过滤与恢复语义
//    保持不变（首个信号必触发、窗口过后新信号照常触发、他席会话信号不触发）。
// 2. 运行中信号风暴被合并：经真实 ipcService sequenced dispatcher（双 epoch 交错 /
//    持续序号空洞，两种真机结构）放大的信号，force load 次数被压进上限——基线
//    （无合并）实测 100 事件 → 197 次 load（591 次/分钟 @5 事件/秒），正是宿主
//    `[StreamSnapshot] Found incomplete stream snapshot` INFO 刷到 200~580 条/分钟
//    的源头。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { ipcService } from '../../../src/renderer/services/ipcService';
import { createStreamSnapshotRequiredHandler } from '../../../src/renderer/hooks/agent/streamSnapshotRehydrate';

type EmitAgentEvent = (event: Record<string, unknown>) => void;

function installMockTransport(): EmitAgentEvent {
  const agentEventListeners: Array<(event: Record<string, unknown>) => void> = [];
  const mockOn = vi.fn((channel: string, callback: (event: never) => void) => {
    // 只捕获单事件通道；BATCH 通道收数组，不把单条事件喂给它
    if (channel === IPC_CHANNELS.AGENT_EVENT) {
      agentEventListeners.push(callback as (event: Record<string, unknown>) => void);
    }
    return () => {};
  });
  (globalThis as Record<string, unknown>).window = {
    codeAgentAPI: {
      invoke: vi.fn(),
      on: mockOn,
      off: vi.fn(),
    },
  };
  return (event) => {
    for (const listener of [...agentEventListeners]) listener(event);
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ============================================================================
// handler 单元：过滤语义 + 合并窗口
// ============================================================================

describe('createStreamSnapshotRequiredHandler', () => {
  it('首个信号立即触发重灌（恢复语义不变）', async () => {
    const reloadSession = vi.fn(async () => {});
    const handler = createStreamSnapshotRequiredHandler({
      getCurrentSessionId: () => 'session-1',
      reloadSession,
      now: () => 1_000,
    });

    await handler({ sessionId: 'session-1' });

    expect(reloadSession).toHaveBeenCalledTimes(1);
    expect(reloadSession).toHaveBeenCalledWith('session-1');
  });

  it('运行中风暴被合并：窗口内重复信号只重灌一次', async () => {
    const reloadSession = vi.fn(async () => {});
    let clock = 60_000; // 运行中的某一秒
    const handler = createStreamSnapshotRequiredHandler({
      getCurrentSessionId: () => 'session-1',
      reloadSession,
      now: () => clock,
    });

    // 100 条信号挤在同一个合并窗口内（总跨度 500ms < 1.5s）
    for (let i = 0; i < 100; i++) {
      clock += 5;
      await handler({ sessionId: 'session-1' });
    }

    expect(reloadSession).toHaveBeenCalledTimes(1);
  });

  it('窗口过后新信号再次触发（后续缺口仍可恢复）', async () => {
    const reloadSession = vi.fn(async () => {});
    let clock = 0;
    const handler = createStreamSnapshotRequiredHandler({
      getCurrentSessionId: () => 'session-1',
      reloadSession,
      now: () => clock,
    });

    await handler({ sessionId: 'session-1' });
    clock += 1_501;
    await handler({ sessionId: 'session-1' });

    expect(reloadSession).toHaveBeenCalledTimes(2);
  });

  it('在途合并：重灌未完成时到达的信号被丢弃，不叠加也不推迟', async () => {
    // 只有第一次重灌挂起（受控释放），后续重灌立即完成——否则尾部 await 会吊死在
    // 没人释放的第二把闸上
    let releaseFirstReload: (() => void) | undefined;
    let firstReloadPending = true;
    const reloadSession = vi.fn(() => {
      if (!firstReloadPending) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirstReload = resolve;
      });
    });
    let clock = 10_000;
    const handler = createStreamSnapshotRequiredHandler({
      getCurrentSessionId: () => 'session-1',
      reloadSession,
      now: () => clock,
    });

    const first = handler({ sessionId: 'session-1' });
    await handler({ sessionId: 'session-1' }); // 在途 → 丢弃
    clock += 10_000; // 即便时钟越过窗口，在途期间到达的信号也不放行
    await handler({ sessionId: 'session-1' });
    expect(reloadSession).toHaveBeenCalledTimes(1);

    firstReloadPending = false;
    releaseFirstReload?.();
    await first;
    clock += 10_000; // 上一轮发起时刻起算的窗口已过 → 新信号放行
    await handler({ sessionId: 'session-1' });
    expect(reloadSession).toHaveBeenCalledTimes(2);
  });

  it('会话过滤保持：他席会话信号不触发，全局信号与当前会话信号触发', async () => {
    const reloadSession = vi.fn(async () => {});
    let current: string | null = 'session-1';
    const handler = createStreamSnapshotRequiredHandler({
      getCurrentSessionId: () => current,
      reloadSession,
      now: () => 0,
    });

    await handler({ sessionId: 'session-other' });
    expect(reloadSession).not.toHaveBeenCalled();

    // 无 sessionId 的全局信号（如 SSE connected 重放缺口）按原语义触发当前会话重灌
    await handler({});
    expect(reloadSession).toHaveBeenCalledTimes(1);
    expect(reloadSession).toHaveBeenCalledWith('session-1');

    current = null; // 当前无会话：不动
    await handler({ sessionId: 'session-1' });
    expect(reloadSession).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 端到端频率钉：真实 ipcService sequenced dispatcher → handler
// ============================================================================

describe('snapshot-required storm → force load frequency (N-STREAMSNAPSHOT-LOG-SPAM)', () => {
  let emitAgentEvent: EmitAgentEvent;

  beforeEach(() => {
    emitAgentEvent = installMockTransport();
    // 建立真实 sequenced dispatcher（ipcService.on(AGENT_EVENT) 时创建）
    ipcService.on(IPC_CHANNELS.AGENT_EVENT, () => {});
  });

  it('双 epoch 交错（native:/http: 双计数器）20s×5 事件/秒：load 被压进上限', async () => {
    const reloadSession = vi.fn(async () => {});
    let clock = 0;
    const handler = createStreamSnapshotRequiredHandler({
      getCurrentSessionId: () => 'session-live',
      reloadSession,
      now: () => clock,
    });
    ipcService.on(IPC_CHANNELS.AGENT_STREAM_SNAPSHOT_REQUIRED, handler);

    // 基线同款事件流：100 事件，双 epoch 交错（每次翻转 dispatcher 会同时发
    // epoch_changed 与 sequence_gap 两个信号，无合并时 100 事件 → 197 次 load）
    let nativeSeq = 0;
    let httpSeq = 0;
    for (let i = 0; i < 100; i++) {
      clock += 200; // 20 秒 × 5 事件/秒
      const isNativeLeg = i % 2 === 0;
      if (isNativeLeg) nativeSeq++;
      else httpSeq++;
      emitAgentEvent({
        type: 'stream_chunk',
        streamEpoch: isNativeLeg ? 'native:host-1' : 'http:host-1',
        sessionId: 'session-live',
        seq: isNativeLeg ? nativeSeq : httpSeq,
        data: { content: `chunk-${i}`, turnId: 'turn-1' },
      });
      await drainMicrotasks();
    }

    // 20s / 1.5s 窗口 ⇒ 上限 14（首发起 + 每 1.5s 一次），远低于基线 197；
    // 至少 1 次保证首个信号的重灌没有被吞。
    expect(reloadSession.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(reloadSession.mock.calls.length).toBeLessThanOrEqual(14);
  });

  it('持续序号空洞（单 epoch 子集投递）20s×5 事件/秒：load 同样被压进上限', async () => {
    const reloadSession = vi.fn(async () => {});
    let clock = 0;
    const handler = createStreamSnapshotRequiredHandler({
      getCurrentSessionId: () => 'session-live',
      reloadSession,
      now: () => clock,
    });
    ipcService.on(IPC_CHANNELS.AGENT_STREAM_SNAPSHOT_REQUIRED, handler);

    // 基线同款：renderer 只收到偶数 seq，每条都是 gap（无合并时 100 事件 → 100 次 load）
    for (let i = 0; i < 100; i++) {
      clock += 200;
      emitAgentEvent({
        type: 'stream_chunk',
        streamEpoch: 'http:host-1',
        sessionId: 'session-live',
        seq: (i + 1) * 2,
        data: { content: `chunk-${i}`, turnId: 'turn-1' },
      });
      await drainMicrotasks();
    }

    expect(reloadSession.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(reloadSession.mock.calls.length).toBeLessThanOrEqual(14);
  });
});
