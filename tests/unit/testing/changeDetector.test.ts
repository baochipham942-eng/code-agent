import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { ChangeDetector } from '../../../src/host/testing/ci/changeDetector';

describe('ChangeDetector verification changed files', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('reads git diff --name-only from the detector cwd', () => {
    execFileSyncMock.mockReturnValue('src/host/agent/runtime/goalCompletionGate.ts\n');

    const detector = new ChangeDetector('/repo/worktree');
    const files = detector.getChangedFilesForVerification();

    expect(files).toEqual(['src/host/agent/runtime/goalCompletionGate.ts']);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', 'HEAD'],
      expect.objectContaining({ cwd: '/repo/worktree' }),
    );
  });

  it('falls back to staged files when the working diff cannot be read', () => {
    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error('bad ref');
      })
      .mockReturnValueOnce('src/host/testing/ci/changeDetector.ts\n');

    const detector = new ChangeDetector('/repo/worktree');
    const files = detector.getChangedFilesForVerification('main');

    expect(files).toEqual(['src/host/testing/ci/changeDetector.ts']);
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', '--name-only', '--cached'],
      expect.objectContaining({ cwd: '/repo/worktree' }),
    );
  });
});
