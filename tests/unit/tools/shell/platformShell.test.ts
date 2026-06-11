import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import { killProcessTree } from '../../../../src/main/tools/shell/platformShell';

function makeChild(pid: number | undefined) {
  return { pid, kill: vi.fn() };
}

function makeKillerProc() {
  return { on: vi.fn() };
}

afterEach(() => {
  spawnMock.mockReset();
});

describe('killProcessTree', () => {
  it('does nothing when pid is undefined', () => {
    const child = makeChild(undefined);
    killProcessTree(child, 'SIGTERM', { platform: 'win32' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  describe('win32', () => {
    it('uses taskkill /T for SIGTERM (no force)', () => {
      spawnMock.mockReturnValue(makeKillerProc());
      const child = makeChild(1234);
      killProcessTree(child, 'SIGTERM', { platform: 'win32' });
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/T'],
        expect.objectContaining({ windowsHide: true }),
      );
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('adds /F for SIGKILL', () => {
      spawnMock.mockReturnValue(makeKillerProc());
      const child = makeChild(1234);
      killProcessTree(child, 'SIGKILL', { platform: 'win32' });
      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/T', '/F'],
        expect.anything(),
      );
    });

    it('falls back to child.kill when taskkill spawn throws', () => {
      spawnMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const child = makeChild(1234);
      killProcessTree(child, 'SIGKILL', { platform: 'win32' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('falls back to child.kill when taskkill emits error', () => {
      const killer = makeKillerProc();
      spawnMock.mockReturnValue(killer);
      const child = makeChild(1234);
      killProcessTree(child, 'SIGTERM', { platform: 'win32' });
      const errorHandler = killer.on.mock.calls.find(([event]) => event === 'error')?.[1] as
        | ((err: Error) => void)
        | undefined;
      expect(errorHandler).toBeDefined();
      errorHandler?.(new Error('spawn taskkill ENOENT'));
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('posix', () => {
    it('group-kills via -pid when posixGroupKill is set', () => {
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = makeChild(4321);
      killProcessTree(child, 'SIGTERM', { posixGroupKill: true, platform: 'darwin' });
      expect(processKill).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(child.kill).not.toHaveBeenCalled();
      processKill.mockRestore();
    });

    it('falls back to child.kill when group kill throws', () => {
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('ESRCH');
      });
      const child = makeChild(4321);
      killProcessTree(child, 'SIGTERM', { posixGroupKill: true, platform: 'darwin' });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      processKill.mockRestore();
    });

    it('kills the direct child by default (no group kill)', () => {
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = makeChild(4321);
      killProcessTree(child, 'SIGKILL', { platform: 'linux' });
      expect(processKill).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      processKill.mockRestore();
    });
  });
});
