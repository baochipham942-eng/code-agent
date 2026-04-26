import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/main/tools/types';

const surfaceMocks = vi.hoisted(() => {
  const state = {
    allow: false,
    sensitive: false,
  };
  const surfaceState = {
    id: 'default-computer-surface',
    mode: 'foreground_fallback' as const,
    platform: 'darwin',
    ready: true,
    background: false,
    requiresForeground: true,
    approvalScope: 'session_app' as const,
    safetyNote: 'Computer Surface 会作用于当前前台 app/window；没有后台隔离。',
    targetApp: 'Safari',
    approvedApps: [],
    deniedApps: ['Terminal'],
    lastAction: null,
    lastSnapshot: null,
  };
  const trace = {
    id: 'computer-trace-1',
    targetKind: 'computer' as const,
    toolName: 'computer_use',
    action: 'click',
    mode: 'foreground_fallback',
    startedAtMs: 1,
  };

  const surface = {
    authorizeAction: vi.fn(async () => ({
      allowed: state.allow,
      reason: state.allow ? undefined : 'Computer Use for Safari was not approved.',
      state: surfaceState,
      trace,
      sensitive: state.sensitive,
    })),
    observe: vi.fn(async () => ({
      capturedAtMs: 1,
      appName: 'Safari',
      windowTitle: 'Example Page',
      screenshotPath: '/tmp/surface.png',
    })),
    executeBackgroundAction: vi.fn(async () => ({
      success: true,
      output: 'Background click completed: Finder',
      metadata: {
        backgroundSurface: true,
        targetApp: 'Finder',
        targetRole: 'button',
        targetName: 'Back',
        targetAxPath: '1.2',
      },
    })),
    executeBackgroundCgEventAction: vi.fn(async () => ({
      success: true,
      output: 'Background CGEvent click completed: Preview · pid=1234 windowId=42 · windowRef=cgwin:1234:42:abcdef123456 · bounds=100,200 640x480 · windowLocal=(50, 60) · screen=(150, 260) · active=no · usedWindowLocation=yes · eventNumbers=101,102 · button=left clickCount=1',
      metadata: {
        backgroundSurface: true,
        computerSurfaceMode: 'background_cgevent',
        targetApp: 'Preview',
        targetPid: 1234,
        targetWindowId: 42,
        targetWindowRef: 'cgwin:1234:42:abcdef123456',
        targetWindowBounds: { x: 100, y: 200, width: 640, height: 480 },
        windowLocalPoint: { x: 50, y: 60 },
        screenPoint: { x: 150, y: 260 },
        isTargetActive: false,
        usedWindowLocation: true,
        eventNumbers: [101, 102],
        button: 'left',
        clickCount: 1,
        evidenceSummary: [
          'pid=1234 windowId=42 windowRef=cgwin:1234:42:abcdef123456',
          'active=no usedWindowLocation=yes',
          'button=left clickCount=1 eventNumbers=101,102',
        ],
      },
    })),
    listBackgroundElements: vi.fn(async () => ({
      success: true,
      output: 'Found 1 background AX elements for Finder:\n1. AXButton "Back" [axPath=1.2]',
      metadata: {
        backgroundSurface: true,
        targetApp: 'Finder',
        elements: [{ index: 1, role: 'AXButton', name: 'Back', axPath: '1.2' }],
        targetElementCount: 1,
        axQuality: {
          score: 0.65,
          grade: 'usable',
          elementCount: 1,
          labeledElementCount: 1,
          withAxPathCount: 1,
          unlabeledRatio: 0,
          missingAxPathRatio: 0,
          duplicateLabelRoleCount: 0,
          roleCounts: { AXButton: 1 },
          reasons: ['only 1 interactive AX element returned'],
        },
      },
    })),
    listBackgroundCgEventWindows: vi.fn(async () => ({
      success: true,
      output: 'Found 1 background CGEvent windows for Preview:\nPreview "Document" · pid=1234 · windowId=42 · bounds=100,200 640x480',
      metadata: {
        backgroundSurface: true,
        computerSurfaceMode: 'background_cgevent',
        targetApp: 'Preview',
        windows: [{
          appName: 'Preview',
          pid: 1234,
          windowId: 42,
          windowRef: 'cgwin:1234:42:abcdef123456',
          title: 'Document',
          bounds: { x: 100, y: 200, width: 640, height: 480 },
          qualityScore: 92,
          qualityGrade: 'recommended',
          qualityReasons: ['ordinary layer', 'reasonable bounds'],
          recommended: true,
        }],
        targetWindowCount: 1,
        recommendedWindow: {
          appName: 'Preview',
          pid: 1234,
          windowId: 42,
          windowRef: 'cgwin:1234:42:abcdef123456',
          title: 'Document',
          bounds: { x: 100, y: 200, width: 640, height: 480 },
          qualityScore: 92,
          qualityGrade: 'recommended',
          qualityReasons: ['ordinary layer', 'reasonable bounds'],
          recommended: true,
        },
      },
    })),
    diagnoseApp: vi.fn(async () => ({
      success: true,
      output: [
        'Computer Surface diagnosis for Preview',
        'TCC: Accessibility=granted · ScreenRecording=granted',
        'AX suitability: yes',
        'CGEvent suitability: yes',
        'Recommended window: Preview "Document"',
      ].join('\n'),
      metadata: {
        backgroundSurface: true,
        computerSurfaceMode: 'background_cgevent',
        targetApp: 'Preview',
        appDiagnosis: {
          targetApp: 'Preview',
          capturedAtMs: 1,
          platform: 'darwin',
          helper: { available: true, path: '/tmp/helper' },
          os: { version: 'macOS 15.0' },
          permissions: { accessibilityTrusted: true, screenRecordingGranted: true },
          symbols: { cgEventSetWindowLocationAvailable: true },
          processes: [{ appName: 'Preview', pid: 1234, bundleId: 'com.apple.Preview', isActive: false }],
          windows: [{
            appName: 'Preview',
            pid: 1234,
            windowId: 42,
            windowRef: 'cgwin:1234:42:abcdef123456',
            title: 'Document',
            bounds: { x: 100, y: 200, width: 640, height: 480 },
            qualityScore: 92,
            qualityGrade: 'recommended',
            qualityReasons: ['ordinary layer', 'reasonable bounds'],
            recommended: true,
          }],
          recommendedWindow: {
            appName: 'Preview',
            pid: 1234,
            windowId: 42,
            windowRef: 'cgwin:1234:42:abcdef123456',
            title: 'Document',
            bounds: { x: 100, y: 200, width: 640, height: 480 },
          },
          ax: { suitable: true, trusted: true, appWindowCount: 1, errors: [], reasons: ['AX can read target windows'], perPid: [{ pid: 1234, ok: true, windowCount: 1 }] },
          cgEvent: { suitable: true, canUseWindowLocation: true, candidateWindowCount: 1, reasons: ['CGEvent has a recommended candidate window'] },
        },
        recommendedWindow: {
          appName: 'Preview',
          pid: 1234,
          windowId: 42,
          windowRef: 'cgwin:1234:42:abcdef123456',
          title: 'Document',
          bounds: { x: 100, y: 200, width: 640, height: 480 },
        },
        windows: [{
          appName: 'Preview',
          pid: 1234,
          windowId: 42,
          windowRef: 'cgwin:1234:42:abcdef123456',
          title: 'Document',
          bounds: { x: 100, y: 200, width: 640, height: 480 },
        }],
        tcc: { accessibilityTrusted: true, screenRecordingGranted: true },
        axSuitable: true,
        cgEventSuitable: true,
      },
    })),
    recordAction: vi.fn(async (inputTrace: typeof trace, result: { success: boolean; error?: string | null }) => ({
      ...inputTrace,
      completedAtMs: 2,
      success: result.success,
      error: result.error || null,
    })),
    getState: vi.fn(() => surfaceState),
  };

  return { state, surface };
});

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn((_command, _args, callback) => {
    const done = typeof callback === 'function' ? callback : undefined;
    queueMicrotask(() => done?.(null, '', ''));
    return {} as never;
  }),
}));

vi.mock('../../../../src/main/services/desktop/computerSurface', () => ({
  getComputerSurface: () => surfaceMocks.surface,
}));

vi.mock('child_process', () => ({
  execFile: childProcessMocks.execFile,
}));

vi.mock('../../../../src/main/services/cloud/featureFlagService', () => ({
  isComputerUseEnabled: () => true,
}));

import { computerUseTool } from '../../../../src/main/tools/vision/computerUse';

const originalPlatform = process.platform;

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/workbench',
    requestPermission: async () => true,
    ...overrides,
  };
}

describe('computer surface gating', () => {
  beforeEach(() => {
    surfaceMocks.state.allow = false;
    surfaceMocks.state.sensitive = false;
    surfaceMocks.surface.authorizeAction.mockClear();
    surfaceMocks.surface.observe.mockClear();
    surfaceMocks.surface.executeBackgroundAction.mockClear();
    surfaceMocks.surface.executeBackgroundCgEventAction.mockClear();
    surfaceMocks.surface.listBackgroundElements.mockClear();
    surfaceMocks.surface.listBackgroundCgEventWindows.mockClear();
    surfaceMocks.surface.diagnoseApp.mockClear();
    surfaceMocks.surface.recordAction.mockClear();
    surfaceMocks.surface.getState.mockClear();
    childProcessMocks.execFile.mockClear();
    setProcessPlatform(originalPlatform);
  });

  it('returns computer surface state without asking for app approval', async () => {
    const result = await computerUseTool.execute(
      {
        action: 'get_state',
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Computer Surface: ready');
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'foreground_fallback',
      foregroundFallback: true,
      background: false,
      requiresForeground: true,
      approvalScope: 'session_app',
      targetApp: 'Safari',
    });
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
  });

  it('observes the frontmost computer surface before acting', async () => {
    const result = await computerUseTool.execute(
      {
        action: 'observe',
        includeScreenshot: true,
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Frontmost: Safari');
    expect(result.metadata?.computerSurfaceSnapshot).toMatchObject({
      appName: 'Safari',
      windowTitle: 'Example Page',
      screenshotPath: '/tmp/surface.png',
    });
    expect(result.metadata).toMatchObject({
      requiresForeground: true,
      approvalScope: 'session_app',
      targetApp: 'Safari',
    });
    expect(surfaceMocks.surface.observe).toHaveBeenCalledWith({ includeScreenshot: true });
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
  });

  it('blocks foreground desktop actions when app approval is denied', async () => {
    const result = await computerUseTool.execute(
      {
        action: 'click',
        x: 10,
        y: 20,
        targetApp: 'Safari',
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not approved');
    expect(result.metadata).toMatchObject({
      code: 'COMPUTER_SURFACE_BLOCKED',
      foregroundFallback: true,
      background: false,
      requiresForeground: true,
      approvalScope: 'session_app',
      targetApp: 'Safari',
      traceId: 'computer-trace-1',
    });
    expect(surfaceMocks.surface.recordAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'computer-trace-1',
    }), expect.objectContaining({ success: false }));
  });

  it('surfaces target_not_frontmost taxonomy on foreground fallback blocks', async () => {
    surfaceMocks.surface.authorizeAction.mockResolvedValueOnce({
      allowed: false,
      reason: 'Computer Surface foreground fallback requires the target app to be frontmost. Requested Finder, current frontmost is Safari.',
      state: {
        ...surfaceMocks.surface.getState(),
        mode: 'foreground_fallback',
        background: false,
        requiresForeground: true,
        approvalScope: 'blocked',
        targetApp: 'Finder',
        blockedReason: 'target app is not foreground: current Safari',
      },
      trace: {
        id: 'computer-trace-frontmost',
        targetKind: 'computer' as const,
        toolName: 'computer_use',
        action: 'click',
        mode: 'foreground_fallback',
        startedAtMs: 1,
        failureKind: 'target_not_frontmost',
        blockingReasons: ['Requested Finder, current frontmost is Safari.'],
        recommendedAction: 'Bring Finder to the foreground or use a background AX locator.',
      },
      sensitive: false,
      failureKind: 'target_not_frontmost',
      blockingReasons: ['Requested Finder, current frontmost is Safari.'],
      recommendedAction: 'Bring Finder to the foreground or use a background AX locator.',
    });
    surfaceMocks.surface.recordAction.mockImplementationOnce(async (inputTrace, result) => ({
      ...inputTrace,
      completedAtMs: 2,
      success: result.success,
      error: result.error || null,
    }));

    const result = await computerUseTool.execute(
      {
        action: 'click',
        x: 10,
        y: 20,
        targetApp: 'Finder',
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      failureKind: 'target_not_frontmost',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('Finder'),
      ]),
      recommendedAction: expect.any(String),
      targetApp: 'Finder',
      workbenchTrace: expect.objectContaining({
        failureKind: 'target_not_frontmost',
        blockingReasons: expect.arrayContaining([
          expect.stringContaining('Finder'),
        ]),
        recommendedAction: expect.any(String),
      }),
    });
  });

  it('blocks targetApp background actions without a locator before requesting permission', async () => {
    const requestPermission = vi.fn(async () => true);

    const result = await computerUseTool.execute(
      {
        action: 'click',
        targetApp: 'Finder',
      },
      makeContext({ requestPermission }),
    );

    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      code: 'COMPUTER_SURFACE_BLOCKED',
      failureKind: 'locator_missing',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('locator'),
      ]),
      recommendedAction: expect.any(String),
      targetApp: 'Finder',
    });
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('normalizes background action execution failures into action_execution_failed metadata', async () => {
    const backgroundState = {
      ...surfaceMocks.surface.getState(),
      mode: 'background_ax' as const,
      background: true,
      requiresForeground: false,
      approvalScope: 'session_app' as const,
      targetApp: 'Finder',
    };
    surfaceMocks.surface.authorizeAction.mockResolvedValueOnce({
      allowed: true,
      state: backgroundState,
      trace: {
        id: 'computer-trace-exec-failed',
        targetKind: 'computer' as const,
        toolName: 'computer_use',
        action: 'click',
        mode: 'background_ax',
        startedAtMs: 1,
      },
      sensitive: false,
    });
    surfaceMocks.surface.getState.mockReturnValueOnce(backgroundState);
    surfaceMocks.surface.executeBackgroundAction.mockResolvedValueOnce({
      success: false,
      error: 'Background action failed: Target element not found',
    });
    surfaceMocks.surface.recordAction.mockImplementationOnce(async (inputTrace, result) => ({
      ...inputTrace,
      completedAtMs: 2,
      success: result.success,
      error: result.error || null,
      failureKind: 'action_execution_failed',
      blockingReasons: ['Background action failed: Target element not found'],
      recommendedAction: 'Refresh AX elements and retry with a current axPath or role/name locator.',
    }));

    const result = await computerUseTool.execute(
      {
        action: 'click',
        targetApp: 'Finder',
        axPath: '1.2',
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Target element not found');
    expect(result.metadata).toMatchObject({
      failureKind: 'action_execution_failed',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('Target element not found'),
      ]),
      recommendedAction: expect.any(String),
      workbenchTrace: expect.objectContaining({
        failureKind: 'action_execution_failed',
        blockingReasons: expect.arrayContaining([
          expect.stringContaining('Target element not found'),
        ]),
        recommendedAction: expect.any(String),
      }),
    });
  });

  it('marks sensitive foreground desktop denials in metadata', async () => {
    surfaceMocks.state.sensitive = true;

    const result = await computerUseTool.execute(
      {
        action: 'type',
        text: 'secret@example.com',
        targetApp: 'Safari',
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      code: 'COMPUTER_SURFACE_BLOCKED',
      sensitiveAction: true,
      foregroundFallback: true,
      targetApp: 'Safari',
    });
  });

  it('uses osascript argv for foreground typing instead of shell interpolation', async () => {
    setProcessPlatform('darwin');
    surfaceMocks.state.allow = true;

    const text = 'secret@example.com "\n; rm -rf /';
    const result = await computerUseTool.execute(
      {
        action: 'type',
        text,
        targetApp: 'Safari',
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const [command, args] = childProcessMocks.execFile.mock.calls[0] || [];
    expect(command).toBe('osascript');
    expect(args).toEqual(expect.arrayContaining([
      'tell application "System Events" to keystroke (item 1 of argv)',
      text,
    ]));
    expect(result.output).toContain(`text: ${text.length} chars`);
    expect(result.output).not.toContain(text);
  });

  it('routes approved background AX actions through the computer surface executor', async () => {
    const backgroundState = {
      id: 'default-computer-surface',
      mode: 'background_ax' as const,
      platform: 'darwin',
      ready: true,
      background: true,
      requiresForeground: false,
      approvalScope: 'session_app' as const,
      safetyNote: 'Computer Surface 会通过 macOS Accessibility 操作指定 app/window；坐标类动作仍需前台窗口兜底。',
      targetApp: 'Finder',
      approvedApps: ['Finder'],
      deniedApps: ['Terminal'],
      lastAction: null,
      lastSnapshot: null,
    };
    surfaceMocks.surface.authorizeAction.mockResolvedValueOnce({
      allowed: true,
      state: backgroundState,
      trace: {
        id: 'computer-trace-bg',
        targetKind: 'computer' as const,
        toolName: 'computer_use',
        action: 'click',
        mode: 'background_ax',
        startedAtMs: 1,
      },
      sensitive: false,
    });
    surfaceMocks.surface.getState.mockReturnValueOnce(backgroundState);

    const result = await computerUseTool.execute(
      {
        action: 'click',
        targetApp: 'Finder',
        axPath: '1.2',
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(surfaceMocks.surface.executeBackgroundAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'click',
      targetApp: 'Finder',
      axPath: '1.2',
    }));
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'background_ax',
      backgroundSurface: true,
      foregroundFallback: false,
      background: true,
      requiresForeground: false,
      targetApp: 'Finder',
    });
  });

  it('routes approved background CGEvent clicks through the computer surface executor', async () => {
    const cgeventState = {
      id: 'default-computer-surface',
      mode: 'background_cgevent' as const,
      platform: 'darwin',
      ready: true,
      background: true,
      requiresForeground: false,
      approvalScope: 'session_app' as const,
      safetyNote: 'Computer Surface 会向指定 macOS pid/windowId 投递 CGEvent；必须先选窗口并使用窗口内坐标。',
      targetApp: 'Preview',
      approvedApps: ['Preview'],
      deniedApps: ['Terminal'],
      lastAction: null,
      lastSnapshot: null,
    };
    surfaceMocks.surface.authorizeAction.mockResolvedValueOnce({
      allowed: true,
      state: cgeventState,
      trace: {
        id: 'computer-trace-cgevent',
        targetKind: 'computer' as const,
        toolName: 'computer_use',
        action: 'click',
        mode: 'background_cgevent',
        startedAtMs: 1,
      },
      sensitive: false,
    });
    surfaceMocks.surface.getState.mockReturnValueOnce(cgeventState);

    const result = await computerUseTool.execute(
      {
        action: 'click',
        targetApp: 'Preview',
        pid: 1234,
        windowId: 42,
        windowLocalPoint: { x: 50, y: 60 },
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(surfaceMocks.surface.executeBackgroundCgEventAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'click',
      targetApp: 'Preview',
      pid: 1234,
      windowId: 42,
      windowLocalPoint: { x: 50, y: 60 },
    }));
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'background_cgevent',
      backgroundSurface: true,
      foregroundFallback: false,
      background: true,
      requiresForeground: false,
      targetApp: 'Preview',
      targetWindowId: 42,
      targetPid: 1234,
      targetWindowRef: 'cgwin:1234:42:abcdef123456',
      usedWindowLocation: true,
      isTargetActive: false,
      eventNumbers: [101, 102],
      evidenceSummary: expect.arrayContaining([
        expect.stringContaining('windowRef=cgwin:1234:42:abcdef123456'),
        expect.stringContaining('usedWindowLocation=yes'),
        expect.stringContaining('eventNumbers=101,102'),
      ]),
    });
    expect(surfaceMocks.surface.recordAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'computer-trace-cgevent',
    }), expect.objectContaining({
      evidenceSummary: expect.arrayContaining([
        expect.stringContaining('windowRef=cgwin:1234:42:abcdef123456'),
      ]),
    }));
  });

  it('classifies stale background CGEvent windows as target_window_not_found', async () => {
    const cgeventState = {
      id: 'default-computer-surface',
      mode: 'background_cgevent' as const,
      platform: 'darwin',
      ready: true,
      background: true,
      requiresForeground: false,
      approvalScope: 'session_app' as const,
      safetyNote: 'Computer Surface 会向指定 macOS pid/windowId 投递 CGEvent；必须先选窗口并使用窗口内坐标。',
      targetApp: 'Preview',
      approvedApps: ['Preview'],
      deniedApps: ['Terminal'],
      lastAction: null,
      lastSnapshot: null,
    };
    surfaceMocks.surface.authorizeAction.mockResolvedValueOnce({
      allowed: true,
      state: cgeventState,
      trace: {
        id: 'computer-trace-cgevent-stale',
        targetKind: 'computer' as const,
        toolName: 'computer_use',
        action: 'click',
        mode: 'background_cgevent',
        startedAtMs: 1,
      },
      sensitive: false,
    });
    surfaceMocks.surface.getState.mockReturnValueOnce(cgeventState);
    surfaceMocks.surface.executeBackgroundCgEventAction.mockResolvedValueOnce({
      success: false,
      error: 'Background CGEvent action failed: Target window verification failed: windowRef is stale: expected cgwin:1234:42:abcdef123456, got null',
    });
    surfaceMocks.surface.recordAction.mockImplementationOnce(async (inputTrace, result) => ({
      ...inputTrace,
      completedAtMs: 2,
      success: result.success,
      error: result.error || null,
      failureKind: result.failureKind,
      blockingReasons: result.blockingReasons,
      recommendedAction: result.recommendedAction,
    }));

    const result = await computerUseTool.execute(
      {
        action: 'click',
        targetApp: 'Preview',
        pid: 1234,
        windowId: 42,
        windowRef: 'cgwin:1234:42:abcdef123456',
        windowLocalPoint: { x: 50, y: 60 },
      },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      failureKind: 'target_window_not_found',
      blockingReasons: expect.arrayContaining([
        expect.stringContaining('windowRef is stale'),
      ]),
      recommendedAction: expect.stringContaining('get_windows'),
      workbenchTrace: expect.objectContaining({
        failureKind: 'target_window_not_found',
      }),
    });
    expect(surfaceMocks.surface.recordAction).toHaveBeenCalledWith(expect.objectContaining({
      id: 'computer-trace-cgevent-stale',
    }), expect.objectContaining({
      failureKind: 'target_window_not_found',
      recommendedAction: expect.stringContaining('get_windows'),
    }));
  });

  it('lists background AX elements without action approval', async () => {
    const backgroundState = {
      id: 'default-computer-surface',
      mode: 'background_ax' as const,
      platform: 'darwin',
      ready: true,
      background: true,
      requiresForeground: false,
      approvalScope: 'session_app' as const,
      safetyNote: 'Computer Surface 会通过 macOS Accessibility 操作指定 app/window；坐标类动作仍需前台窗口兜底。',
      targetApp: 'Finder',
      approvedApps: [],
      deniedApps: ['Terminal'],
      lastAction: null,
      lastSnapshot: null,
    };
    surfaceMocks.surface.getState.mockReturnValueOnce(backgroundState);

    const result = await computerUseTool.execute(
      {
        action: 'get_ax_elements',
        targetApp: 'Finder',
        limit: 10,
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('AXButton');
    expect(result.output).toContain('axPath=1.2');
    expect(surfaceMocks.surface.listBackgroundElements).toHaveBeenCalledWith(expect.objectContaining({
      action: 'get_ax_elements',
      targetApp: 'Finder',
      limit: 10,
    }));
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'background_ax',
      backgroundSurface: true,
      background: true,
      requiresForeground: false,
      targetApp: 'Finder',
      targetElementCount: 1,
      axQuality: expect.objectContaining({
        grade: 'usable',
        score: 0.65,
      }),
    });
    expect(result.metadata?.elements).toEqual([
      expect.objectContaining({
        index: 1,
        role: 'AXButton',
        name: 'Back',
        axPath: '1.2',
      }),
    ]);
  });

  it('lists background CGEvent windows without action approval', async () => {
    const cgeventState = {
      id: 'default-computer-surface',
      mode: 'background_cgevent' as const,
      platform: 'darwin',
      ready: true,
      background: true,
      requiresForeground: false,
      approvalScope: 'session_app' as const,
      safetyNote: 'Computer Surface 会向指定 macOS pid/windowId 投递 CGEvent；必须先选窗口并使用窗口内坐标。',
      targetApp: 'Preview',
      approvedApps: [],
      deniedApps: ['Terminal'],
      lastAction: null,
      lastSnapshot: null,
    };
    surfaceMocks.surface.getState.mockReturnValueOnce(cgeventState);

    const result = await computerUseTool.execute(
      {
        action: 'get_windows',
        targetApp: 'Preview',
        limit: 5,
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('windowId=42');
    expect(surfaceMocks.surface.listBackgroundCgEventWindows).toHaveBeenCalledWith(expect.objectContaining({
      targetApp: 'Preview',
      limit: 5,
    }));
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'background_cgevent',
      backgroundSurface: true,
      background: true,
      requiresForeground: false,
      targetApp: 'Preview',
      targetWindowCount: 1,
      recommendedWindow: expect.objectContaining({
        windowRef: 'cgwin:1234:42:abcdef123456',
        qualityGrade: 'recommended',
      }),
    });
    expect(result.metadata?.windows).toEqual([
      expect.objectContaining({
        windowRef: 'cgwin:1234:42:abcdef123456',
        qualityScore: 92,
        recommended: true,
      }),
    ]);
  });

  it('diagnoses a target app without action approval', async () => {
    const cgeventState = {
      id: 'default-computer-surface',
      mode: 'background_cgevent' as const,
      platform: 'darwin',
      ready: true,
      background: true,
      requiresForeground: false,
      approvalScope: 'session_app' as const,
      safetyNote: 'Computer Surface 会向指定 macOS pid/windowId 投递 CGEvent；必须先选窗口并使用窗口内坐标。',
      targetApp: 'Preview',
      approvedApps: [],
      deniedApps: ['Terminal'],
      lastAction: null,
      lastSnapshot: null,
    };
    surfaceMocks.surface.getState.mockReturnValueOnce(cgeventState);

    const result = await computerUseTool.execute(
      {
        action: 'diagnose_app',
        targetApp: 'Preview',
        limit: 5,
      },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Computer Surface diagnosis for Preview');
    expect(surfaceMocks.surface.diagnoseApp).toHaveBeenCalledWith(expect.objectContaining({
      action: 'diagnose_app',
      targetApp: 'Preview',
      limit: 5,
    }));
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      computerSurfaceMode: 'background_cgevent',
      backgroundSurface: true,
      targetApp: 'Preview',
      appDiagnosis: expect.objectContaining({
        permissions: {
          accessibilityTrusted: true,
          screenRecordingGranted: true,
        },
        ax: expect.objectContaining({ suitable: true }),
        cgEvent: expect.objectContaining({ suitable: true }),
      }),
      recommendedWindow: expect.objectContaining({
        windowRef: 'cgwin:1234:42:abcdef123456',
      }),
      axSuitable: true,
      cgEventSuitable: true,
    });
  });
});
