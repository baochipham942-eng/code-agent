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
  cgeventWindows?: Array<Record<string, unknown>>;
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
    } else if (command === 'xcrun') {
      stdout = '';
    } else if (argList[0] === 'list-windows') {
      stdout = JSON.stringify(options.cgeventWindows || []);
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

  it('blocks denied targetApp observe without reading app window details', async () => {
    const surface = await loadSurface();

    const snapshot = await surface.observe({ targetApp: 'Terminal' });

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      appName: null,
      windowTitle: null,
      failureKind: 'permission_denied',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('protected app'),
      ]),
      recommendedAction: expect.any(String),
    });
  });

  it('blocks denied targetApp get_windows without returning window identifiers', async () => {
    const surface = await loadSurface();

    const result = await surface.listBackgroundCgEventWindows({ targetApp: 'Terminal' });

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'background_cgevent',
      targetApp: null,
      failureKind: 'permission_denied',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('protected app'),
      ]),
      recommendedAction: expect.any(String),
    });
    expect(result.metadata).not.toHaveProperty('windows');
    expect(result.metadata).not.toHaveProperty('recommendedWindow');
  });

  it('front-loads target matches, recommended window, and visible app summary for get_windows', async () => {
    installMacOsSurfaceMocks({
      cgeventWindows: [
        {
          appName: 'WeChat',
          bundleId: 'com.tencent.xin',
          pid: 101,
          windowId: 11,
          title: 'Chats',
          bounds: { x: 0, y: 0, width: 900, height: 700 },
          layer: 0,
          alpha: 1,
          isOnScreen: true,
        },
        {
          appName: 'WeChat',
          bundleId: 'com.tencent.xin',
          pid: 101,
          windowId: 12,
          title: 'Files',
          bounds: { x: 20, y: 20, width: 900, height: 700 },
          layer: 0,
          alpha: 1,
          isOnScreen: true,
        },
        {
          appName: '腾讯会议',
          bundleId: 'com.tencent.meeting',
          pid: 202,
          windowId: 21,
          title: 'Standup',
          bounds: { x: 120, y: 80, width: 1200, height: 800 },
          layer: 0,
          alpha: 1,
          isOnScreen: true,
        },
        {
          appName: '腾讯会议',
          bundleId: 'com.tencent.meeting',
          pid: 202,
          windowId: 22,
          title: 'Share',
          bounds: { x: 160, y: 120, width: 900, height: 640 },
          layer: 0,
          alpha: 1,
          isOnScreen: true,
        },
      ],
    });
    const surface = await loadSurface();

    const result = await surface.listBackgroundCgEventWindows({
      targetApp: 'TencentMeeting',
      limit: 10,
    });

    expect(result.success).toBe(true);
    const firstLines = (result.output || '').split('\n').slice(0, 4).join('\n');
    expect(firstLines).toContain('Target matches: 2');
    expect(firstLines).toContain('腾讯会议/com.tencent.meeting');
    expect(firstLines).toContain('Recommended window: 腾讯会议');
    expect(firstLines).toContain('Visible apps:');
    expect(firstLines).toContain('WeChat/com.tencent.xin x2');
    expect(firstLines).toContain('腾讯会议/com.tencent.meeting x2');
    expect(result.output?.indexOf('Target matches')).toBeLessThan(result.output?.indexOf('Window candidates') || 0);
    expect(result.metadata).toMatchObject({
      targetWindowCount: 2,
      targetMatchCount: 2,
      usedRelaxedTargetFallback: true,
      recommendedWindow: expect.objectContaining({
        appName: '腾讯会议',
        bundleId: 'com.tencent.meeting',
      }),
    });
  });

  it('blocks denied targetApp diagnose_app without returning diagnosis or TCC details', async () => {
    const surface = await loadSurface();

    const result = await surface.diagnoseApp({ action: 'diagnose_app', targetApp: 'Terminal' });

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'background_cgevent',
      targetApp: null,
      failureKind: 'permission_denied',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('protected app'),
      ]),
      recommendedAction: expect.any(String),
    });
    expect(result.metadata).not.toHaveProperty('appDiagnosis');
    expect(result.metadata).not.toHaveProperty('tcc');
    expect(result.metadata).not.toHaveProperty('windows');
  });

  it('blocks denied targetApp authorization before observe and permission prompts', async () => {
    const surface = await loadSurface();
    const requestPermission = vi.fn(async () => true);

    const authorization = await surface.authorizeAction({
      action: 'click',
      targetApp: 'Terminal',
      role: 'button',
      name: 'Run',
    }, {
      sessionId: 'session-a',
      requestPermission,
    });

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(authorization.allowed).toBe(false);
    expect(authorization).toMatchObject({
      failureKind: 'permission_denied',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('protected app'),
      ]),
      recommendedAction: expect.any(String),
    });
    expect(authorization.state).toMatchObject({
      targetApp: null,
      approvalScope: 'blocked',
      failureKind: 'permission_denied',
    });
    expect(authorization.trace.before).toMatchObject({
      appName: null,
      title: null,
    });
    expect(authorization.trace.params).toEqual({ protectedTarget: true });
  });

  it('blocks denied targetApp mutating actions at the surface method', async () => {
    const surface = await loadSurface();

    const axResult = await surface.executeBackgroundAction({
      action: 'click',
      targetApp: 'Terminal',
      role: 'button',
      name: 'Run',
    });
    const cgEventResult = await surface.executeBackgroundCgEventAction({
      action: 'click',
      targetApp: 'Terminal',
      pid: 1234,
      windowId: 42,
      windowLocalPoint: { x: 10, y: 20 },
    });

    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(axResult).toMatchObject({
      success: false,
      metadata: {
        targetApp: null,
        failureKind: 'permission_denied',
        blockingReasons: expect.arrayContaining([
          expect.stringContaining('protected app'),
        ]),
        recommendedAction: expect.any(String),
      },
    });
    expect(cgEventResult).toMatchObject({
      success: false,
      metadata: {
        computerSurfaceMode: 'background_cgevent',
        targetApp: null,
        failureKind: 'permission_denied',
        blockingReasons: expect.arrayContaining([
          expect.stringContaining('protected app'),
        ]),
        recommendedAction: expect.any(String),
      },
    });
  });

  // G26 片1：Code Agent 自身的只读 Computer Surface 操作豁免保护，写操作仍全拦。
  describe('Code Agent self-app read carve-out (G26)', () => {
    it('allows observe on Code Agent itself (read is reentrancy-safe)', async () => {
      const surface = await loadSurface();

      const snapshot = await surface.observe({ targetApp: 'Code Agent' });

      // 放行 = 越过门禁、真去查 app context（mock 的 osascript 被调用）
      expect(childProcessMocks.execFile).toHaveBeenCalled();
      expect(snapshot.failureKind ?? null).not.toBe('permission_denied');
      expect(snapshot.blockingReasons ?? []).not.toContainEqual(
        expect.stringContaining('protected app'),
      );
    });

    it('allows get_ax_elements / get_windows / diagnose_app on Code Agent itself', async () => {
      const surface = await loadSurface();

      const ax = await surface.listBackgroundElements({ action: 'get_ax_elements', targetApp: 'Code Agent' });
      const windows = await surface.listBackgroundCgEventWindows({ targetApp: 'Code Agent' });
      const diagnosis = await surface.diagnoseApp({ action: 'diagnose_app', targetApp: 'Code Agent' });

      for (const result of [ax, windows, diagnosis]) {
        expect(result.error ?? '').not.toContain('protected app');
        expect((result.metadata?.failureKind as string | undefined) ?? null).not.toBe('permission_denied');
      }
    });

    it('still blocks write authorization on Code Agent itself (reentrancy guard)', async () => {
      const surface = await loadSurface();
      const requestPermission = vi.fn(async () => true);

      const authorization = await surface.authorizeAction({
        action: 'click',
        targetApp: 'Code Agent',
        role: 'button',
        name: 'Send',
      }, { requestPermission });

      expect(requestPermission).not.toHaveBeenCalled();
      expect(authorization.allowed).toBe(false);
      expect(authorization).toMatchObject({
        failureKind: 'permission_denied',
        blockingReasons: expect.arrayContaining([
          expect.stringContaining('protected app'),
        ]),
      });
    });

    it('still blocks mutating surface actions on Code Agent itself', async () => {
      const surface = await loadSurface();

      const axResult = await surface.executeBackgroundAction({
        action: 'click',
        targetApp: 'Code Agent',
        role: 'button',
        name: 'Send',
      });
      const cgEventResult = await surface.executeBackgroundCgEventAction({
        action: 'click',
        targetApp: 'Code Agent',
        pid: 1234,
        windowId: 42,
        windowLocalPoint: { x: 10, y: 20 },
      });

      for (const result of [axResult, cgEventResult]) {
        expect(result.success).toBe(false);
        expect(result.metadata).toMatchObject({
          failureKind: 'permission_denied',
          blockingReasons: expect.arrayContaining([
            expect.stringContaining('protected app'),
          ]),
        });
      }
    });
  });

  it('keeps session_app approvals scoped to the current session', async () => {
    const surface = await loadSurface();
    const requestPermission = vi.fn(async () => true);
    const action = {
      action: 'click',
      targetApp: 'Finder',
      role: 'button',
      name: 'Back',
    };

    const sessionAFirst = await surface.authorizeAction(action, {
      sessionId: 'session-a',
      requestPermission,
    });
    const sessionASecond = await surface.authorizeAction(action, {
      sessionId: 'session-a',
      requestPermission,
    });
    const sessionB = await surface.authorizeAction(action, {
      sessionId: 'session-b',
      requestPermission,
    });
    const anonymous = await surface.authorizeAction(action, {
      requestPermission,
    });
    const explicitAfterAnonymous = await surface.authorizeAction(action, {
      sessionId: 'session-c',
      requestPermission,
    });

    expect(sessionAFirst.allowed).toBe(true);
    expect(sessionASecond.allowed).toBe(true);
    expect(sessionB.allowed).toBe(true);
    expect(anonymous.allowed).toBe(true);
    expect(explicitAfterAnonymous.allowed).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(4);
    expect(requestPermission).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'session-a',
    }));
    expect(requestPermission).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'session-b',
    }));
    expect(requestPermission).toHaveBeenNthCalledWith(3, expect.objectContaining({
      sessionId: undefined,
    }));
    expect(requestPermission).toHaveBeenNthCalledWith(4, expect.objectContaining({
      sessionId: 'session-c',
    }));
    expect(surface.getState().approvedApps).toEqual(expect.arrayContaining([
      'session-a:background_ax:finder',
      'session-b:background_ax:finder',
      'session-c:background_ax:finder',
      'anonymous:background_ax:finder',
    ]));
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

  it('locates a desktop element by role and returns its axPath', async () => {
    installMacOsSurfaceMocks({
      axElementsStdout: [
        '1\tbutton\tSubmit\t1.2.3',
        '2\ttextbox\tEmail\t1.2.4',
      ].join('\n'),
    });
    const surface = await loadSurface();

    const result = await surface.locateBackgroundElement({
      action: 'locate_role',
      targetApp: 'Notes',
      role: 'textbox',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('axPath=1.2.4');
    expect(result.metadata).toMatchObject({
      backgroundSurface: true,
      targetApp: 'Notes',
      targetRole: 'textbox',
      targetName: 'Email',
      targetAxPath: '1.2.4',
      axPath: '1.2.4',
      matchCount: 1,
      failureKind: null,
    });
  });

  it('flags locator_ambiguous when multiple elements match and returns the first', async () => {
    installMacOsSurfaceMocks({
      axElementsStdout: [
        '1\tbutton\tSave\t1.2.3',
        '2\tbutton\tSave\t1.2.5',
      ].join('\n'),
    });
    const surface = await loadSurface();

    const result = await surface.locateBackgroundElement({
      action: 'locate_role',
      targetApp: 'Notes',
      role: 'button',
      name: 'Save',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Located 2 matches');
    expect(result.metadata).toMatchObject({
      matchCount: 2,
      axPath: '1.2.3',
      failureKind: 'locator_ambiguous',
      recommendedAction: expect.any(String),
    });
  });

  it('returns locator_missing when no element matches the role', async () => {
    installMacOsSurfaceMocks({
      axElementsStdout: '1\tbutton\tCancel\t1.2.3',
    });
    const surface = await loadSurface();

    const result = await surface.locateBackgroundElement({
      action: 'locate_role',
      targetApp: 'Finder',
      role: 'textbox',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Target element not found');
    expect(result.metadata).toMatchObject({
      failureKind: 'locator_missing',
      recommendedAction: expect.any(String),
    });
  });

  it('rejects locate_role without targetApp at the desktop entry point', async () => {
    const surface = await loadSurface();

    const result = await surface.locateBackgroundElement({
      action: 'locate_role',
      role: 'button',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('targetApp');
  });
});
