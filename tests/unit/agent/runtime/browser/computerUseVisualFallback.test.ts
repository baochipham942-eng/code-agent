import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, observeMock, statMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  observeMock: vi.fn(),
  statMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('fs/promises', () => ({
  stat: statMock,
}));

vi.mock('../../../../../src/host/services/desktop/computerSurface', () => ({
  getComputerSurface: () => ({
    observe: observeMock,
  }),
}));

import { runComputerUseVisualFallback } from '../../../../../src/host/agent/runtime/browser/computerUseVisualFallback';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalFallbackFlag = process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_FALLBACK;
const originalFallbackApp = process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_APP;

describe('runComputerUseVisualFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setProcessPlatform('darwin');
    delete process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_FALLBACK;
    delete process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_APP;
    execFileMock.mockReset();
    observeMock.mockReset();
    statMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (typeof callback === 'function') {
        callback(null, '', '');
      }
      return {} as never;
    });
    observeMock.mockResolvedValue({
      appName: 'Safari',
      windowTitle: 'corgi-adventure.html',
      screenshotPath: '/tmp/corgi-screenshot.png',
    });
    statMock.mockResolvedValue({ size: 4096 });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreProcessPlatform();
    if (originalFallbackFlag === undefined) {
      delete process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_FALLBACK;
    } else {
      process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_FALLBACK = originalFallbackFlag;
    }
    if (originalFallbackApp === undefined) {
      delete process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_APP;
    } else {
      process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_APP = originalFallbackApp;
    }
  });

  it('opens the artifact and returns screenshot evidence through Computer Use', async () => {
    const pending = runComputerUseVisualFallback('/tmp/corgi-adventure.html', 'Playwright package unavailable.');
    await vi.advanceTimersByTimeAsync(1200);
    const result = await pending;

    expect(result).toMatchObject({
      attempted: true,
      passed: true,
      failures: [],
      diagnostics: {
        title: 'corgi-adventure.html',
        computerUseFallback: {
          screenshotPath: '/tmp/corgi-screenshot.png',
          screenshotBytes: 4096,
          frontmostApp: 'Safari',
          windowTitle: 'corgi-adventure.html',
          reason: 'Playwright package unavailable.',
        },
      },
    });
    expect(result.checks.join('\n')).toContain('browser visual smoke fell back to Computer Use desktop surface');
    expect(execFileMock).toHaveBeenCalledWith('open', ['-a', 'Safari', '/tmp/corgi-adventure.html'], { timeout: 8000 }, expect.any(Function));
    expect(observeMock).toHaveBeenCalledWith({ includeScreenshot: true });
  });

  it('can be disabled explicitly for non-interactive environments', async () => {
    process.env.CODE_AGENT_BROWSER_VISUAL_SMOKE_COMPUTER_FALLBACK = '0';

    const result = await runComputerUseVisualFallback('/tmp/corgi-adventure.html', 'System Chrome missing.');

    expect(result).toMatchObject({
      attempted: false,
      skipped: true,
      passed: true,
      failures: [],
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(observeMock).not.toHaveBeenCalled();
  });

  it('degrades to skipped when desktop screenshot evidence is unavailable', async () => {
    observeMock.mockResolvedValueOnce({
      appName: null,
      windowTitle: null,
      screenshotPath: '/tmp/tiny.png',
    });
    statMock.mockResolvedValueOnce({ size: 12 });

    const pending = runComputerUseVisualFallback('/tmp/corgi-adventure.html', 'Playwright missing.');
    await vi.advanceTimersByTimeAsync(1200);
    const result = await pending;

    expect(result).toMatchObject({
      attempted: true,
      skipped: true,
      passed: true,
      failures: [],
    });
    expect(result.checks.join('\n')).toContain('Computer Use visual fallback unavailable');
  });
});

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

function restoreProcessPlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
}
