import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: childProcessMocks.execFile,
}));

const originalPlatform = process.platform;

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

function installMacOsSurfaceMocks(options: {
  frontmostApp?: string;
  missingApps?: string[];
  axElementsStdout?: string;
} = {}): void {
  const frontmostApp = options.frontmostApp || 'Safari';
  const missingApps = new Set((options.missingApps || []).map((item) => item.toLowerCase()));
  childProcessMocks.execFile.mockImplementation((command, args, optionsOrCallback, callback) => {
    const done = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callback;
    if (typeof done !== 'function') {
      throw new Error('execFile callback missing');
    }

    const argList = Array.isArray(args) ? args.map(String) : [];
    const script = argList.join('\n');
    let stdout = '';

    if (command === 'osascript' && script.includes('frontmost is true')) {
      stdout = `${frontmostApp}\nFrontmost Window\n`;
    } else if (command === 'osascript' && script.includes('collectElements')) {
      stdout = options.axElementsStdout ?? '';
    } else if (
      command === 'osascript'
      && script.includes('if exists application process targetApp then return "running"')
    ) {
      const targetApp = argList[argList.length - 1] || 'Finder';
      stdout = missingApps.has(targetApp.toLowerCase()) ? 'missing\n' : 'running\n';
    } else if (
      command === 'osascript'
      && script.includes('set targetApp to item 1 of argv')
      && !script.includes('set actionName to item 2 of argv')
    ) {
      const targetApp = argList[argList.length - 1] || 'Finder';
      stdout = missingApps.has(targetApp.toLowerCase())
        ? `${targetApp}\n`
        : `${targetApp}\nTarget Window\n`;
    }

    queueMicrotask(() => done(null, stdout, ''));
    return {} as never;
  });
}

async function loadSurface() {
  vi.resetModules();
  const mod = await import('../../../../src/main/services/desktop/computerSurface');
  return mod.getComputerSurface();
}

describe('DesktopComputerSurface target boundaries', () => {
  beforeEach(() => {
    setProcessPlatform('darwin');
    vi.stubEnv('CODE_AGENT_COMPUTER_BACKGROUND_SURFACE', '1');
    childProcessMocks.execFile.mockReset();
    installMacOsSurfaceMocks();
  });

  afterEach(() => {
    setProcessPlatform(originalPlatform);
    vi.unstubAllEnvs();
  });

  it('blocks foreground fallback when targetApp is not the current frontmost app', async () => {
    const surface = await loadSurface();
    const requestPermission = vi.fn(async () => true);

    const authorization = await surface.authorizeAction({
      action: 'click',
      targetApp: 'Finder',
      x: 10,
      y: 20,
    }, { requestPermission });

    expect(authorization.allowed).toBe(false);
    expect(authorization.reason).toContain('requires the target app to be frontmost');
    expect(authorization.state).toMatchObject({
      mode: 'foreground_fallback',
      approvalScope: 'blocked',
      requiresForeground: true,
      targetApp: 'Finder',
    });
    expect(authorization).toMatchObject({
      failureKind: 'target_not_frontmost',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('frontmost'),
      ]),
      recommendedAction: expect.any(String),
    });
    expect(authorization.trace).toMatchObject({
      failureKind: 'target_not_frontmost',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('frontmost'),
      ]),
      recommendedAction: expect.any(String),
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('keeps role-only targetApp actions on the foreground fallback path', async () => {
    const surface = await loadSurface();
    const requestPermission = vi.fn(async () => true);

    const authorization = await surface.authorizeAction({
      action: 'click',
      targetApp: 'Finder',
      role: 'button',
    }, { requestPermission });

    expect(authorization.allowed).toBe(false);
    expect(authorization.trace.mode).toBe('foreground_fallback');
    expect(authorization.reason).toContain('requires the target app to be frontmost');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('allows background AX only when targetApp has a specific locator', async () => {
    const surface = await loadSurface();
    const requestPermission = vi.fn(async () => true);

    const authorization = await surface.authorizeAction({
      action: 'click',
      targetApp: 'Finder',
      role: 'button',
      name: 'Back',
    }, { requestPermission });

    expect(authorization.allowed).toBe(true);
    expect(authorization.trace.mode).toBe('background_ax');
    expect(authorization.state).toMatchObject({
      mode: 'background_ax',
      background: true,
      requiresForeground: false,
      targetApp: 'Finder',
    });
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({
        targetApp: 'Finder',
        surfaceMode: 'background_ax',
        background: true,
        requiresForeground: false,
      }),
    }));
  });

  it('allows background CGEvent only with an explicit targetApp and window-local locator', async () => {
    const surface = await loadSurface();
    const requestPermission = vi.fn(async () => true);

    const authorization = await surface.authorizeAction({
      action: 'click',
      targetApp: 'Finder',
      pid: 1234,
      windowId: 42,
      windowLocalPoint: { x: 20, y: 30 },
    }, { requestPermission });

    expect(authorization.allowed).toBe(true);
    expect(authorization.trace.mode).toBe('background_cgevent');
    expect(authorization.state).toMatchObject({
      mode: 'background_cgevent',
      background: true,
      requiresForeground: false,
      targetApp: 'Finder',
    });
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({
        targetApp: 'Finder',
        surfaceMode: 'background_cgevent',
        background: true,
        requiresForeground: false,
      }),
    }));
  });

  it('blocks CGEvent window locators without an explicit targetApp', async () => {
    const surface = await loadSurface();
    const requestPermission = vi.fn(async () => true);

    const authorization = await surface.authorizeAction({
      action: 'click',
      pid: 1234,
      windowId: 42,
      windowLocalPoint: { x: 20, y: 30 },
    }, { requestPermission });

    expect(authorization.allowed).toBe(false);
    expect(authorization.failureKind).toBe('target_window_not_found');
    expect(authorization.reason).toContain('explicit targetApp');
    expect(authorization.trace.mode).toBe('foreground_fallback');
    expect(authorization.trace).toMatchObject({
      failureKind: 'target_window_not_found',
      recommendedAction: expect.stringContaining('targetApp'),
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('blocks background AX actions when targetApp is not running before requesting permission', async () => {
    const surface = await loadSurface();
    (surface as unknown as {
      getTargetAppProcessStatus: (_targetApp: string) => Promise<{ running: boolean }>;
    }).getTargetAppProcessStatus = async () => ({ running: false });
    const requestPermission = vi.fn(async () => true);

    const authorization = await surface.authorizeAction({
      action: 'click',
      targetApp: 'Notes',
      role: 'button',
      name: 'New Note',
    }, { requestPermission });

    expect(authorization.allowed).toBe(false);
    expect(authorization.reason).toContain('Notes');
    expect(authorization.state).toMatchObject({
      mode: 'background_ax',
      approvalScope: 'blocked',
      targetApp: 'Notes',
    });
    expect(authorization).toMatchObject({
      failureKind: 'target_app_not_running',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('Notes'),
      ]),
      recommendedAction: expect.any(String),
    });
    expect(authorization.trace).toMatchObject({
      failureKind: 'target_app_not_running',
      recommendedAction: expect.any(String),
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('grades poor AX candidate lists for dogfood triage', async () => {
    installMacOsSurfaceMocks({ axElementsStdout: '' });
    const surface = await loadSurface();

    const result = await surface.listBackgroundElements({
      action: 'get_ax_elements',
      targetApp: 'Finder',
      limit: 10,
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('AX quality: poor');
    expect(result.metadata).toMatchObject({
      targetApp: 'Finder',
      targetElementCount: 0,
      failureKind: 'ax_tree_poor',
      axQuality: expect.objectContaining({
        grade: 'poor',
        score: 0,
        elementCount: 0,
        reasons: expect.arrayContaining([
          expect.stringContaining('no interactive AX elements'),
        ]),
      }),
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('AX tree quality is poor'),
      ]),
      recommendedAction: expect.any(String),
    });
  });
});
