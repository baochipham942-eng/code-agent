import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeListSessionCandidates } from '../../../../../src/host/tools/modules/delegation/listSessionCandidates';

const ctx = { sessionId: 'origin', turnId: 'turn-1', workingDir: '/workspace/origin', abortSignal: new AbortController().signal } as never;
const setRuntime = (value: unknown) => {
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = value;
};
const allow = vi.fn(async () => ({ allow: true as const }));

afterEach(() => {
  delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  setRuntime(undefined);
});

describe('list_session_candidates', () => {
  it('flag off returns FEATURE_DISABLED without touching the host', async () => {
    const result = await executeListSessionCandidates({}, ctx, allow);
    expect(result).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' });
  });

  it('returns capped opaque candidates without stable session ids', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    setRuntime({
      listSessions: () => [
        { id: 'target-1', title: 'Target One', workingDirectory: '/workspace/target', updatedAt: 10, sessionType: 'chat' },
        { id: 'origin', title: 'Origin', workingDirectory: '/workspace/origin', updatedAt: 20, sessionType: 'chat' },
      ],
      now: () => 20,
      getRun: () => undefined,
    });
    const result = await executeListSessionCandidates({}, ctx, allow);
    expect(result.ok).toBe(true);
    const text = (result as { output: string }).output;
    expect(text).toContain('candidateSetId');
    expect(text).toContain('candidateRef');
    expect(text).not.toContain('target-1');
    expect(text).not.toContain('sessionId');
  });

  it('caps the projection at 32 entries, each carrying only the five model-visible fields', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      workingDirectory: `/workspace/repo-${index}`,
      updatedAt: 1000 - index,
      sessionType: 'chat',
    }));
    setRuntime({ listSessions: () => rows, now: () => 2000, getRun: () => undefined });
    const result = await executeListSessionCandidates({}, ctx, allow);
    if (result.ok !== true) throw new Error('candidate listing must succeed');
    const payload = JSON.parse(result.output) as {
      candidateSetId: string;
      candidates: Array<Record<string, unknown>>;
    };
    expect(payload.candidates).toHaveLength(32);
    expect(typeof payload.candidateSetId).toBe('string');
    for (const candidate of payload.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(['candidateRef', 'freshness', 'shortName', 'status', 'workspaceName']);
    }
    // stable sessionId 不进模型输入也不进工具输出：扫整个输出串
    const serialized = result.output;
    for (const row of rows) {
      expect(serialized).not.toContain(row.id);
    }
  });

  it('host read failure is a structured ambiguous rejection, never a fabricated candidate list', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    setRuntime({
      listSessions: () => { throw new Error('database is closed'); },
      now: () => 1,
    });
    const result = await executeListSessionCandidates({}, ctx, allow);
    expect(result).toMatchObject({ ok: false, code: 'DELEGATION_REJECTED' });
    const error = (result as { error: string }).error;
    expect(error).toContain('ambiguous');
    expect(error).toContain('AskUserQuestion');
    expect(error).toContain('do not retry with create_new');
  });
});
