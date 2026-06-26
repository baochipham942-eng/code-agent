import { describe, expect, it, vi } from 'vitest';
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
    const agentId = reg.spawn(async () => fakeResult('42'));

    const result = await reg.await(agentId);
    expect(result?.output).toBe('42');
    expect(reg.getStatus(agentId)?.status).toBe('completed');
    expect(reg.getStatus(agentId)?.result?.output).toBe('42');
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
});
