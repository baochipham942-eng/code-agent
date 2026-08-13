import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import { killProcessTree } from '../../../../src/host/tools/shell/platformShell';

/**
 * 已退出的子进程句柄：signalCode 非 null ⇒ killProcessTree 判「树已死」立刻返回。
 * 这是本文件能用 mock 覆盖的边界——「还活着的树何时算死」只有真进程能证明，
 * 见 killProcessTree.realProcess.test.ts。
 */
function makeExitedChild(pid: number | undefined) {
  return {
    pid,
    kill: vi.fn(),
    exitCode: null as number | null,
    signalCode: 'SIGTERM' as NodeJS.Signals | null,
  };
}

/** signalCode 初值是 null，但用例会在轮询途中把它改成信号名——类型必须写成联合而非 null 字面量。 */
function makeLiveChild(pid: number | undefined) {
  return {
    pid,
    kill: vi.fn(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  };
}

function makeKillerProc() {
  return { on: vi.fn() };
}

afterEach(() => {
  spawnMock.mockReset();
});

describe('killProcessTree', () => {
  it('does nothing when pid is undefined', async () => {
    const child = makeLiveChild(undefined);
    await killProcessTree(child, { platform: 'win32' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('returns immediately without signalling an already-exited tree', async () => {
    const child = makeExitedChild(1234);
    await killProcessTree(child, { platform: 'win32' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  describe('win32', () => {
    // win32 拿不到进程组语义：taskkill /T 之后只能以直接子进程退出为边界（降级）。
    // 这里让句柄在第一次轮询时已退出，验证发信号的形状。
    it('uses taskkill /T for the initial SIGTERM (no force)', async () => {
      spawnMock.mockReturnValue(makeKillerProc());
      const child = makeLiveChild(1234);
      const pending = killProcessTree(child, { platform: 'win32', pollIntervalMs: 1, graceMs: 5000 });
      child.signalCode = 'SIGTERM';
      await pending;

      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/T'],
        expect.objectContaining({ windowsHide: true }),
      );
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('escalates to taskkill /F when the tree outlives the grace period', async () => {
      spawnMock.mockReturnValue(makeKillerProc());
      const child = makeLiveChild(1234);
      const pending = killProcessTree(child, { platform: 'win32', pollIntervalMs: 1, graceMs: 20 });
      setTimeout(() => { child.signalCode = 'SIGKILL'; }, 60);
      await pending;

      expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T'], expect.anything());
      expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T', '/F'], expect.anything());
    });

    it('falls back to child.kill when taskkill spawn throws', async () => {
      spawnMock.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const child = makeLiveChild(1234);
      const pending = killProcessTree(child, { platform: 'win32', pollIntervalMs: 1, graceMs: 5000 });
      child.signalCode = 'SIGTERM';
      await pending;

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('falls back to child.kill when taskkill emits error', async () => {
      const killer = makeKillerProc();
      spawnMock.mockReturnValue(killer);
      const child = makeLiveChild(1234);
      const pending = killProcessTree(child, { platform: 'win32', pollIntervalMs: 1, graceMs: 5000 });
      const errorHandler = killer.on.mock.calls.find(([event]) => event === 'error')?.[1] as
        | ((err: Error) => void)
        | undefined;
      expect(errorHandler).toBeDefined();
      errorHandler?.(new Error('spawn taskkill ENOENT'));
      child.signalCode = 'SIGTERM';
      await pending;

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('posix', () => {
    it('group-kills via -pid when posixGroupKill is set', async () => {
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = makeLiveChild(4321);
      const pending = killProcessTree(child, { posixGroupKill: true, platform: 'darwin', pollIntervalMs: 1, graceMs: 5000 });
      child.signalCode = 'SIGTERM';
      // 组探活（kill(-pid, 0)）此时返回成功 = 组还在，所以改成抛 ESRCH 表示组没了
      processKill.mockImplementation(() => {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      });
      await pending;

      expect(processKill).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(child.kill).not.toHaveBeenCalled();
      processKill.mockRestore();
    });

    it('falls back to child.kill when group kill throws', async () => {
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      });
      const child = makeLiveChild(4321);
      const pending = killProcessTree(child, { posixGroupKill: true, platform: 'darwin', pollIntervalMs: 1, graceMs: 5000 });
      child.signalCode = 'SIGTERM';
      await pending;

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      processKill.mockRestore();
    });

    it('kills the direct child by default (no group kill)', async () => {
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const child = makeLiveChild(4321);
      const pending = killProcessTree(child, { platform: 'linux', pollIntervalMs: 1, graceMs: 5000 });
      child.signalCode = 'SIGTERM';
      await pending;

      expect(processKill).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      processKill.mockRestore();
    });
  });
});
