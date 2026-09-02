// ============================================================================
// sendMemberInput 三分路由（N-SUBAGENT-INPUT）：专家团 / spawn 子代理 / 委派后台任务
// 各走一条现成通道，已收工拒收不排队，回执三态。
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import { sendMemberInput, type MemberInputDeps } from '../../../src/host/agent/memberInput';
import { RUNTIME_INPUT_REDIRECT_LINE } from '../../../src/shared/constants/runtimeInput';

function deps(overrides: Partial<MemberInputDeps> = {}): MemberInputDeps {
  return {
    sendSwarmUserMessage: vi.fn().mockResolvedValue({ delivered: true, persisted: true }),
    spawnGuard: {
      get: vi.fn().mockReturnValue(undefined),
      sendMessage: vi.fn().mockReturnValue(false),
    },
    commandCenter: {
      list: vi.fn().mockReturnValue([]),
      steer: vi.fn().mockResolvedValue({ outcome: 'missing' }),
    },
    ...overrides,
  };
}

const base = { sessionId: 'session-a', memberName: '调研员', message: '顺便把页码加上', timestamp: 1000 } as const;

describe('sendMemberInput', () => {
  it('专家团成员：走 swarm:send-user-message，带直达路由与 runtimeInputMode，回执「已送到」', async () => {
    const d = deps();
    const receipt = await sendMemberInput(
      { ...base, kind: 'expert', runId: 'run-a', memberId: 'scoped:researcher', mode: 'supplement', messageId: 'm1' },
      d,
    );
    expect(receipt).toEqual({ outcome: 'delivered', effect: 'next_step', persisted: true });
    expect(d.sendSwarmUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      runId: 'run-a',
      agentId: 'scoped:researcher',
      message: '顺便把页码加上',
      messageId: 'm1',
      timestamp: 1000,
      metadata: expect.objectContaining({
        workbench: expect.objectContaining({ routingMode: 'direct', targetAgentIds: ['scoped:researcher'], runtimeInputMode: 'supplement' }),
        memberInput: { memberId: 'scoped:researcher', memberName: '调研员', mode: 'supplement' },
      }),
    }));
  });

  it('专家团成员改道：投递文本带改道指令行（执行器只在两轮之间抽干，下一轮生效）', async () => {
    const d = deps();
    await sendMemberInput({ ...base, kind: 'expert', runId: 'run-a', memberId: 'r', mode: 'redirect' }, d);
    const payload = (d.sendSwarmUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as { message: string; displayMessage?: string };
    expect(payload.message).toContain('顺便把页码加上');
    expect(payload.message).toContain(RUNTIME_INPUT_REDIRECT_LINE);
    // 落库/账本用原话：指令行不能露给用户
    expect(payload.displayMessage).toBe('顺便把页码加上');
  });

  it('专家团成员已收工（处理器 delivered:false）：拒收，不排队', async () => {
    const d = deps({ sendSwarmUserMessage: vi.fn().mockResolvedValue({ delivered: false, persisted: false }) });
    const receipt = await sendMemberInput({ ...base, kind: 'expert', runId: 'run-a', memberId: 'r', mode: 'supplement' }, d);
    expect(receipt).toEqual({ outcome: 'rejected', reason: 'finished' });
    expect(d.spawnGuard.sendMessage).not.toHaveBeenCalled();
  });

  it('spawn 子代理没有 run 作用域：退到 SpawnGuard 按会话直投，消息 from=user', async () => {
    const d = deps({
      spawnGuard: {
        get: vi.fn().mockReturnValue({ status: 'running' }),
        sendMessage: vi.fn().mockReturnValue(true),
      },
    });
    const receipt = await sendMemberInput({ ...base, kind: 'agent', memberId: 'agent-9', mode: 'supplement' }, d);
    expect(receipt).toEqual({ outcome: 'delivered', effect: 'next_step', persisted: false });
    expect(d.sendSwarmUserMessage).not.toHaveBeenCalled();
    expect(d.spawnGuard.sendMessage).toHaveBeenCalledWith(
      'agent-9',
      expect.objectContaining({ type: 'text', from: 'user', payload: '顺便把页码加上' }),
      { sessionId: 'session-a' },
    );
  });

  it('spawn 子代理带 run 作用域但处理器投不到：仍回退 SpawnGuard（回退摘掉即「没送到」）', async () => {
    const d = deps({
      sendSwarmUserMessage: vi.fn().mockResolvedValue({ delivered: false, persisted: false }),
      spawnGuard: {
        get: vi.fn().mockReturnValue({ status: 'running' }),
        sendMessage: vi.fn().mockReturnValue(true),
      },
    });
    const receipt = await sendMemberInput({ ...base, kind: 'agent', runId: 'run-a', memberId: 'agent-9', mode: 'supplement' }, d);
    expect(receipt).toMatchObject({ outcome: 'delivered', effect: 'next_step' });
  });

  it('spawn 子代理已结束：拒收「finished」；完全找不到：「not_found」', async () => {
    const finished = deps({ spawnGuard: { get: vi.fn().mockReturnValue({ status: 'completed' }), sendMessage: vi.fn() } });
    await expect(sendMemberInput({ ...base, kind: 'agent', memberId: 'agent-9', mode: 'supplement' }, finished))
      .resolves.toEqual({ outcome: 'rejected', reason: 'finished' });
    expect(finished.spawnGuard.sendMessage).not.toHaveBeenCalled();

    const missing = deps();
    await expect(sendMemberInput({ ...base, kind: 'agent', memberId: 'ghost', mode: 'supplement' }, missing))
      .resolves.toEqual({ outcome: 'rejected', reason: 'not_found' });
  });

  it('后台任务运行中：commandCenter.steer 以 origin=user 注入，回执「已读到」(now)', async () => {
    const d = deps({
      commandCenter: {
        list: vi.fn().mockReturnValue([]),
        steer: vi.fn().mockResolvedValue({ outcome: 'resolved', task: { id: 'task-7', status: 'running' } }),
      },
    });
    const receipt = await sendMemberInput({ ...base, kind: 'task', memberId: 'task-7', mode: 'redirect' }, d);
    expect(receipt).toEqual({ outcome: 'delivered', effect: 'now', persisted: true });
    expect(d.commandCenter.steer).toHaveBeenCalledWith('session-a', 'task-7', '顺便把页码加上', {
      origin: 'user',
      mode: 'redirect',
      memberName: '调研员',
      messageId: undefined,
      timestamp: 1000,
    });
  });

  it('后台任务还在排队：追加到任务书，回执「已送到」(queued)', async () => {
    const d = deps({
      commandCenter: {
        list: vi.fn().mockReturnValue([]),
        steer: vi.fn().mockResolvedValue({ outcome: 'resolved', task: { id: 'task-7', status: 'queued' } }),
      },
    });
    await expect(sendMemberInput({ ...base, kind: 'task', memberId: 'task-7', mode: 'supplement', messageId: 'm-queued' }, d))
      .resolves.toEqual({ outcome: 'delivered', effect: 'queued', persisted: true });
    expect(d.commandCenter.steer).toHaveBeenCalledWith('session-a', 'task-7', '顺便把页码加上', expect.objectContaining({ messageId: 'm-queued', timestamp: 1000 }));
  });

  it('后台任务已收工：拒收「finished」，不排队；不存在：「not_found」', async () => {
    const d = deps({
      commandCenter: {
        list: vi.fn().mockReturnValue([{ id: 'task-7', status: 'completed' }]),
        steer: vi.fn().mockResolvedValue({ outcome: 'missing' }),
      },
    });
    await expect(sendMemberInput({ ...base, kind: 'task', memberId: 'task-7', mode: 'supplement' }, d))
      .resolves.toEqual({ outcome: 'rejected', reason: 'finished' });
    await expect(sendMemberInput({ ...base, kind: 'task', memberId: 'task-x', mode: 'supplement' }, d))
      .resolves.toEqual({ outcome: 'rejected', reason: 'not_found' });
  });

  it('空文本直接拒收 not_found 之外的任何投递都不发生', async () => {
    const d = deps();
    await expect(sendMemberInput({ ...base, kind: 'expert', runId: 'run-a', memberId: 'r', mode: 'supplement', message: '   ' }, d))
      .rejects.toThrow(/message/);
    expect(d.sendSwarmUserMessage).not.toHaveBeenCalled();
  });
});
