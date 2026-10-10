import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeListSessionCandidates } from '../../../../../src/host/tools/modules/delegation/listSessionCandidates';
import { setDelegationToolRuntimeForTests } from '../../../../../src/host/services/delegation/delegationToolRuntime';

const ctx = { sessionId: 'origin', workingDir: '/workspace/origin', abortSignal: new AbortController().signal } as never;

afterEach(() => {
  delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  setDelegationToolRuntimeForTests(null);
});

describe('list_session_candidates', () => {
  it('returns capped opaque candidates without stable session ids', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    setDelegationToolRuntimeForTests({
      listSessions: () => [
        { id: 'target-1', title: 'Target One', workingDirectory: '/workspace/target', updatedAt: 10, sessionType: 'chat' },
        { id: 'origin', title: 'Origin', workingDirectory: '/workspace/origin', updatedAt: 20, sessionType: 'chat' },
      ],
      now: () => 20,
      getRun: () => undefined,
    });
    const result = await executeListSessionCandidates({}, ctx, vi.fn(async () => ({ allow: true as const })));
    expect(result.ok).toBe(true);
    const text = (result as { output: string }).output;
    expect(text).toContain('candidateSetId');
    expect(text).toContain('candidateRef');
    expect(text).not.toContain('target-1');
    expect(text).not.toContain('sessionId');
  });
});
