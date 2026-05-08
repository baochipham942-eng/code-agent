import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: childProcessMocks.execFile,
}));

const surfaceMocks = vi.hoisted(() => ({
  listWindows: vi.fn(),
}));

vi.mock('../../../../src/main/services/desktop/backgroundCgEventSurface', () => ({
  backgroundCgEventSurface: { listWindows: surfaceMocks.listWindows },
}));

const originalPlatform = process.platform;

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function defaultExecFileMock(): void {
  childProcessMocks.execFile.mockImplementation((_cmd, _args, optionsOrCb, cb) => {
    const done = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    if (typeof done === 'function') {
      done(null, { stdout: '', stderr: '' });
    }
  });
}

describe('ComputerSurface.screenshotApp (multi-agent crop path)', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
    surfaceMocks.listWindows.mockReset();
    setProcessPlatform('darwin');
  });

  afterEach(() => {
    setProcessPlatform(originalPlatform);
  });

  it('issues screencapture -R with floored window bounds', async () => {
    surfaceMocks.listWindows.mockResolvedValue([
      {
        windowId: 1,
        pid: 100,
        appName: 'TestApp',
        bounds: { x: 50.7, y: 100.3, width: 800.5, height: 600.9 },
      },
    ]);
    defaultExecFileMock();

    const { getComputerSurface } = await import('../../../../src/main/services/desktop/computerSurface');
    const surface = getComputerSurface();
    const filepath = await surface.screenshotApp('TestApp');

    expect(filepath).toBeTruthy();
    expect(filepath).toMatch(/code-agent-computer-surface-app-\d+\.png$/);

    const screencaptureCall = childProcessMocks.execFile.mock.calls.find(
      ([cmd, args]) => cmd === 'screencapture' && Array.isArray(args) && args.includes('-R'),
    );
    expect(screencaptureCall).toBeTruthy();
    const args = screencaptureCall![1] as string[];
    const rIndex = args.indexOf('-R');
    expect(args[rIndex + 1]).toBe('50,100,800,600');
    expect(args).toContain('-x');
  });

  it('returns null when listWindows yields nothing', async () => {
    surfaceMocks.listWindows.mockResolvedValue([]);
    defaultExecFileMock();

    const { getComputerSurface } = await import('../../../../src/main/services/desktop/computerSurface');
    const result = await getComputerSurface().screenshotApp('TestApp');
    expect(result).toBeNull();
    expect(childProcessMocks.execFile).not.toHaveBeenCalledWith(
      'screencapture',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns null when window bounds have zero width/height', async () => {
    surfaceMocks.listWindows.mockResolvedValue([
      { windowId: 1, pid: 100, appName: 'TestApp', bounds: { x: 0, y: 0, width: 0, height: 100 } },
    ]);
    defaultExecFileMock();

    const { getComputerSurface } = await import('../../../../src/main/services/desktop/computerSurface');
    const result = await getComputerSurface().screenshotApp('TestApp');
    expect(result).toBeNull();
  });

  it('returns null when listWindows throws (graceful failure, never blocks observe)', async () => {
    surfaceMocks.listWindows.mockRejectedValue(new Error('AX permission denied'));
    defaultExecFileMock();

    const { getComputerSurface } = await import('../../../../src/main/services/desktop/computerSurface');
    const result = await getComputerSurface().screenshotApp('TestApp');
    expect(result).toBeNull();
  });

  it('returns null on non-darwin platforms (no-op)', async () => {
    setProcessPlatform('linux');

    const { getComputerSurface } = await import('../../../../src/main/services/desktop/computerSurface');
    const result = await getComputerSurface().screenshotApp('TestApp');
    expect(result).toBeNull();
    expect(surfaceMocks.listWindows).not.toHaveBeenCalled();
  });
});
