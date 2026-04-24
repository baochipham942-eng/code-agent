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
    listBackgroundElements: vi.fn(async () => ({
      success: true,
      output: 'Found 1 background AX elements for Finder:\n1. AXButton "Back" [axPath=1.2]',
      metadata: {
        backgroundSurface: true,
        targetApp: 'Finder',
        elements: [{ index: 1, role: 'AXButton', name: 'Back', axPath: '1.2' }],
        targetElementCount: 1,
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

vi.mock('../../../../src/main/services/desktop/computerSurface', () => ({
  getComputerSurface: () => surfaceMocks.surface,
}));

vi.mock('../../../../src/main/services/cloud/featureFlagService', () => ({
  isComputerUseEnabled: () => true,
}));

import { computerUseTool } from '../../../../src/main/tools/vision/computerUse';

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
    surfaceMocks.surface.listBackgroundElements.mockClear();
    surfaceMocks.surface.recordAction.mockClear();
    surfaceMocks.surface.getState.mockClear();
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
});
