import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeResult(output: string): SubagentResult {
  return { success: true, output, toolsUsed: [], iterations: 1 };
}

describe('BackgroundSubagentRegistry', () => {
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CODE_AGENT_DATA_DIR;
    } else {
      process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    }
  });

  it('returns an agentId immediately without awaiting the run (non-blocking)', async () => {
    const reg = new BackgroundSubagentRegistry();
    const d = deferred<SubagentResult>();

    const agentId = reg.spawn(() => d.promise);

    // run 还没 resolve，但 spawn 已经返回了 id 且状态 running
    expect(typeof agentId).toBe('string');
    expect(agentId.length).toBeGreaterThan(0);
    expect(reg.getStatus(agentId)?.status).toBe('running');

    d.resolve(fakeResult('done'));
    await reg.await(agentId);
    expect(reg.getStatus(agentId)?.status).toBe('completed');
  });

  it('captures the result when the run completes', async () => {
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => fakeResult('42'), {
      role: 'report-writer',
      declaredOutputs: ['markdown 报告'],
    });

    const result = await reg.await(agentId);
    expect(result?.output).toBe('42');
    expect(reg.getStatus(agentId)?.status).toBe('completed');
    expect(reg.getStatus(agentId)?.result?.output).toBe('42');
    expect(reg.getStatus(agentId)).toMatchObject({
      role: 'report-writer',
      declaredOutputs: ['markdown 报告'],
    });
  });

  it('marks failed and records the error when the run throws', async () => {
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => { throw new Error('boom'); });

    await reg.await(agentId);
    const status = reg.getStatus(agentId);
    expect(status?.status).toBe('failed');
    expect(status?.error).toContain('boom');
    expect(status?.failureCode).toBe(AgentFailureCode.Unknown);
  });

  it('marks failed result payloads as failed and keeps their unified failure code', async () => {
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => ({
      success: false,
      output: '',
      error: 'budget exhausted',
      toolsUsed: [],
      iterations: 1,
      failureCode: AgentFailureCode.BudgetExhausted,
    }));

    await reg.await(agentId);
    const status = reg.getStatus(agentId);
    expect(status?.status).toBe('failed');
    expect(status?.failureCode).toBe(AgentFailureCode.BudgetExhausted);
  });

  it('issues distinct ids for concurrent background subagents', () => {
    const reg = new BackgroundSubagentRegistry();
    const a = reg.spawn(() => deferred<SubagentResult>().promise);
    const b = reg.spawn(() => deferred<SubagentResult>().promise);
    expect(a).not.toBe(b);
    expect(reg.getStatus(a)?.status).toBe('running');
    expect(reg.getStatus(b)?.status).toBe('running');
  });

  it('returns undefined status and await for unknown ids', async () => {
    const reg = new BackgroundSubagentRegistry();
    expect(reg.getStatus('nope')).toBeUndefined();
    expect(await reg.await('nope')).toBeUndefined();
  });

  it('await resolves immediately for an already-completed run', async () => {
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => fakeResult('quick'));
    await reg.await(agentId);
    // 再 await 一次仍拿到同一结果
    const again = await reg.await(agentId);
    expect(again?.output).toBe('quick');
  });

  it('queues scoped completion records once and drains them without duplicates', async () => {
    const reg = new BackgroundSubagentRegistry(() => 1_000);
    const agentId = reg.spawn(async () => fakeResult('done'), {
      sessionId: 'session-a',
      runId: 'run-a',
      treeId: 'tree-a',
      role: 'coder',
    });

    await reg.await(agentId);
    const first = reg.drainCompletionNotifications({ sessionId: 'session-a', runId: 'run-a' });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      agentId,
      role: 'coder',
      status: 'completed',
      durationMs: 0,
    });
    expect(first[0]?.content).toContain('"agent_id": "subagent-bg-1"');
    expect(reg.drainCompletionNotifications({ sessionId: 'session-a', runId: 'run-a' })).toEqual([]);
  });

  it('archives outputs over 4KB and keeps the raw body out of the completion notice', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'code-agent-bg-completion-'));
    process.env.CODE_AGENT_DATA_DIR = tempDir;
    const raw = `BEGIN-${'x'.repeat(4_200)}-END`;
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => fakeResult(raw), {
      sessionId: 'session-large',
      runId: 'run-large',
    });

    await reg.await(agentId);
    const [record] = reg.drainCompletionNotifications({ sessionId: 'session-large', runId: 'run-large' });

    expect(record?.content).toContain('Output exceeded inline reminder budget');
    expect(record?.content).toContain(`collect_agent(\\"${agentId}\\")`);
    expect(record?.content).toContain('read_tool_result_archive');
    expect(record?.content).not.toContain(raw);
    expect(record?.archiveRef?.artifactId).toContain('tool_result:session-large:subagent_completion');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('does not wake the parent while a block-wait collect is already covering the agent', async () => {
    const onComplete = vi.fn();
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => fakeResult('done'), {
      sessionId: 'session-block-wait',
      suppressIdleWake: true,
      suppressReason: 'block-wait',
      onComplete,
    });

    await reg.await(agentId);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not wake the parent for cancelled background agents', async () => {
    const onComplete = vi.fn();
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => ({
      success: false,
      output: '',
      error: 'cancelled',
      toolsUsed: [],
      iterations: 1,
      failureCode: AgentFailureCode.CancelledByUser,
    }), {
      sessionId: 'session-cancelled',
      onComplete,
    });

    await reg.await(agentId);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not wake the parent from a goal loop', async () => {
    const onComplete = vi.fn();
    const reg = new BackgroundSubagentRegistry();
    const agentId = reg.spawn(async () => fakeResult('done'), {
      sessionId: 'session-goal',
      suppressIdleWake: true,
      suppressReason: 'goal-loop',
      onComplete,
    });

    await reg.await(agentId);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('adopts an already running promise under a stable agent id and completes once', async () => {
    const d = deferred<SubagentResult>();
    const onComplete = vi.fn();
    const reg = new BackgroundSubagentRegistry();

    const agentId = reg.adopt(d.promise, {
      agentId: 'agent-coder-stable',
      sessionId: 'session-adopt',
      runId: 'run-adopt',
      role: 'coder',
      onComplete,
    });
    expect(agentId).toBe('agent-coder-stable');
    expect(reg.getStatus(agentId)?.status).toBe('running');

    d.resolve(fakeResult('adopted done'));
    const result = await reg.await(agentId);

    expect(result?.output).toBe('adopted done');
    expect(reg.getStatus(agentId)).toMatchObject({
      agentId: 'agent-coder-stable',
      status: 'completed',
      result: expect.objectContaining({ output: 'adopted done' }),
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(reg.drainCompletionNotifications({ sessionId: 'session-adopt', runId: 'run-adopt' })).toHaveLength(1);
    expect(reg.drainCompletionNotifications({ sessionId: 'session-adopt', runId: 'run-adopt' })).toEqual([]);
  });
});
