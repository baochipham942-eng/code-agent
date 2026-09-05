// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  invokeDomain: (...args: unknown[]) => invokeDomain(...args),
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { toast } from '../../../src/renderer/hooks/useToast';
import { useFolderTrustPrompt } from '../../../src/renderer/hooks/useFolderTrustPrompt';

const untrusted = (dir: string) => ({
  state: 'untrusted' as const,
  canonicalRealpath: dir,
  displayPath: dir,
  dangerousItems: [{ kind: 'project-hooks', path: `${dir}/.code-agent/hooks/hooks.json`, risk: 'execution' as const, gated: true }],
  blockedItems: [],
  identityChanged: false,
});

afterEach(() => {
  cleanup();
  invokeDomain.mockReset();
});

// N-FIRSTRUN-SKIP：无目录不问；弹窗与决定绑定同一目录，切目录立即清框（ai-review #1636 两轮意见）。
describe('useFolderTrustPrompt', () => {
  it('does not evaluate when the session has no working directory', async () => {
    const { result } = renderHook(() => useFolderTrustPrompt(null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invokeDomain).not.toHaveBeenCalled();
    expect(result.current.evaluation).toBeNull();
  });

  it('clears the prompt when the directory changes and writes the decision to the prompted directory only', async () => {
    invokeDomain.mockImplementation(async (_domain: string, action: string, payload: { workingDirectory: string }) => (
      action === 'get' ? untrusted(payload.workingDirectory) : { ...untrusted(payload.workingDirectory), state: 'trusted' }
    ));
    const { result, rerender } = renderHook(({ dir }) => useFolderTrustPrompt(dir), { initialProps: { dir: '/a' } });
    await waitFor(() => expect(result.current.evaluation?.displayPath).toBe('/a'));

    rerender({ dir: '/b' });
    expect(result.current.evaluation).toBeNull(); // 切目录那一刻旧框立刻消失，不等 B 的评估回来
    await waitFor(() => expect(result.current.evaluation?.displayPath).toBe('/b'));

    await act(async () => { await result.current.decide('trusted'); });
    const setCalls = invokeDomain.mock.calls.filter(([, action]) => action === 'set');
    expect(setCalls).toEqual([['domain:folderTrust', 'set', { state: 'trusted', workingDirectory: '/b' }]]);
    expect(result.current.evaluation).toBeNull();
  });

  it('shows why folder trust cannot be saved and lets the user choose blocked', async () => {
    const reason = 'This filesystem does not provide folder creation time. Folder trust cannot be saved.';
    invokeDomain.mockImplementation(async (_domain: string, action: string, payload: { workingDirectory: string; state?: string }) => {
      if (action === 'get') return untrusted(payload.workingDirectory);
      if (payload.state === 'trusted') throw new Error(reason);
      return { ...untrusted(payload.workingDirectory), state: 'blocked' };
    });
    const { result } = renderHook(() => useFolderTrustPrompt('/project'));
    await waitFor(() => expect(result.current.evaluation).not.toBeNull());
    await act(async () => { await result.current.decide('trusted'); });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(reason));
    expect(result.current.isBusy).toBe(false);
    expect(result.current.evaluation?.state).toBe('untrusted');
    await act(async () => { await result.current.decide('blocked'); });
    expect(result.current.evaluation).toBeNull();
  });

});
