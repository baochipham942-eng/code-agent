import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';
import type { ComputerSurfaceState, WorkbenchActionTrace } from '../../../../src/shared/contract/desktop';
import {
  checkLease,
  computerUseObservedTarget,
  recordTarget,
} from '../../../../src/host/tools/vision/computerUseTargetLease';

const surfaceState: ComputerSurfaceState = {
  id: 'default-computer-surface',
  mode: 'foreground_fallback',
  platform: 'darwin',
  ready: true,
  background: false,
  requiresForeground: true,
  approvalScope: 'session_app',
  safetyNote: 'foreground',
  targetApp: 'Notes',
  approvedApps: [],
  deniedApps: [],
  lastAction: null,
  lastSnapshot: null,
};

const trace: WorkbenchActionTrace = {
  id: 'computer-trace-lease',
  targetKind: 'computer',
  toolName: 'computer_use',
  action: 'type',
  mode: 'foreground_fallback',
  startedAtMs: 1,
};

const surfaceMocks = vi.hoisted(() => {
  const allow = { value: true };
  const surface = {
    authorizeAction: vi.fn(async () => ({
      allowed: allow.value,
      reason: allow.value ? undefined : 'not approved',
      state: surfaceState,
      trace,
      sensitive: false,
    })),
    observe: vi.fn(async () => ({
      capturedAtMs: 1,
      appName: 'Notes',
      windowTitle: 'Untitled',
      screenshotPath: null,
    })),
    executeBackgroundAction: vi.fn(async () => ({ success: true, output: 'typed in background' })),
    executeBackgroundCgEventAction: vi.fn(async () => ({ success: true, output: 'typed via cgevent' })),
    recordAction: vi.fn(async (inputTrace: WorkbenchActionTrace) => ({
      ...inputTrace,
      completedAtMs: 2,
      success: true,
    })),
    getState: vi.fn(() => surfaceState),
    locateBackgroundElement: vi.fn(),
  };
  return { allow, surface };
});

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn((_command: string, _args: unknown, callback?: (error: null, stdout: string, stderr: string) => void) => {
    const done = typeof callback === 'function' ? callback : undefined;
    queueMicrotask(() => done?.(null, '', ''));
    return {} as never;
  }),
}));

vi.mock('../../../../src/host/services/desktop/computerSurface', () => ({
  getComputerSurface: () => surfaceMocks.surface,
}));

vi.mock('child_process', () => ({
  execFile: childProcessMocks.execFile,
}));

vi.mock('../../../../src/host/services/cloud/featureFlagService', () => ({
  isComputerUseEnabled: () => true,
}));

import { computerUseTool } from '../../../../src/host/tools/vision/computerUse';

const originalPlatform = process.platform;

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

let seq = 0;

function identity(tag: string): { sessionId: string; turnId: string; agentId: string } {
  seq += 1;
  return {
    sessionId: `lease-${tag}-session-${seq}`,
    turnId: `lease-${tag}-turn-${seq}`,
    agentId: `lease-${tag}-agent-${seq}`,
  };
}

function makeContext(id: { sessionId: string; turnId: string; agentId: string }): ToolContext {
  return {
    workingDirectory: '/tmp/workbench',
    requestPermission: async () => true,
    ...id,
  };
}

async function declareNotes(context: ToolContext): Promise<void> {
  surfaceMocks.allow.value = true;
  const opened = await computerUseTool.execute(
    { action: 'open_application', targetApp: 'Notes' },
    context,
  );
  expect(opened.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
  surfaceMocks.surface.authorizeAction.mockClear();
  surfaceMocks.surface.executeBackgroundAction.mockClear();
  surfaceMocks.surface.executeBackgroundCgEventAction.mockClear();
  childProcessMocks.execFile.mockClear();
}

describe('computer use target app lease', () => {
  beforeEach(() => {
    surfaceMocks.allow.value = true;
    surfaceMocks.surface.authorizeAction.mockClear();
    surfaceMocks.surface.executeBackgroundAction.mockClear();
    surfaceMocks.surface.executeBackgroundCgEventAction.mockClear();
    surfaceMocks.surface.recordAction.mockClear();
    childProcessMocks.execFile.mockClear();
    setProcessPlatform('darwin');
  });

  afterEach(() => {
    setProcessPlatform(originalPlatform);
  });

  it('refuses type and key without targetApp after the turn declared Notes', async () => {
    const context = makeContext(identity('declared'));
    await declareNotes(context);

    const typed = await computerUseTool.execute({ action: 'type', text: 'hello' }, context);
    const keyed = await computerUseTool.execute({ action: 'key', key: 'enter' }, context);
    const blank = await computerUseTool.execute({ action: 'type', text: 'x', targetApp: '   ' }, context);

    for (const result of [typed, keyed, blank]) {
      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('COMPUTER_TARGET_REQUIRED');
      expect(result.error).toContain('This turn is operating Notes');
      expect(result.error).toContain('targetApp:"Notes"');
      expect(result.error).toContain('axPath');
    }
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
    expect(surfaceMocks.surface.executeBackgroundAction).not.toHaveBeenCalled();
    expect(surfaceMocks.surface.executeBackgroundCgEventAction).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('allows the first untargeted type, a targeted type, and a different turn, session, or agent', async () => {
    const first = makeContext(identity('first'));
    const untargeted = await computerUseTool.execute({ action: 'type', text: 'hi' }, first);
    expect(untargeted.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
    expect(surfaceMocks.surface.authorizeAction).toHaveBeenCalled();

    const named = makeContext(identity('named'));
    await declareNotes(named);
    const targeted = await computerUseTool.execute(
      { action: 'type', text: 'hi', targetApp: 'Notes', axPath: '1.2' },
      named,
    );
    expect(targeted.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
    expect(surfaceMocks.surface.authorizeAction).toHaveBeenCalled();

    const base = identity('split');
    await declareNotes(makeContext(base));
    for (const other of [
      { ...base, turnId: `${base.turnId}-other` },
      { ...base, sessionId: `${base.sessionId}-other` },
      { ...base, agentId: `${base.agentId}-other` },
    ]) {
      surfaceMocks.surface.authorizeAction.mockClear();
      const result = await computerUseTool.execute({ action: 'type', text: 'elsewhere' }, makeContext(other));
      expect(result.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
      expect(surfaceMocks.surface.authorizeAction).toHaveBeenCalled();
    }
  });

  it('refuses untargeted type and key inside computer_batch and still allows a targeted sub-action', async () => {
    const context = makeContext(identity('batch'));
    await declareNotes(context);

    const bareType = await computerUseTool.execute({
      action: 'computer_batch',
      actions: [{ action: 'type', text: 'hi' }],
    }, context);
    const bareKey = await computerUseTool.execute({
      action: 'computer_batch',
      actions: [{ action: 'click', x: 1, y: 2 }, { action: 'key', key: 'enter' }],
    }, context);
    expect(bareType.success).toBe(false);
    expect(bareKey.success).toBe(false);
    expect(bareType.metadata?.code).toBe('COMPUTER_TARGET_REQUIRED');
    expect(bareKey.metadata?.code).toBe('COMPUTER_TARGET_REQUIRED');
    expect(surfaceMocks.surface.authorizeAction).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();

    const targeted = await computerUseTool.execute({
      action: 'computer_batch',
      actions: [{ action: 'type', text: 'hi', targetApp: 'Notes', axPath: '1' }],
    }, context);
    expect(targeted.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
    expect(surfaceMocks.surface.authorizeAction).toHaveBeenCalled();
  });

  it('does not lease a targetApp when authorization denies the action', async () => {
    const context = makeContext(identity('denied'));
    surfaceMocks.allow.value = false;
    const denied = await computerUseTool.execute(
      { action: 'open_application', targetApp: 'Notes' },
      context,
    );
    expect(denied.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
    surfaceMocks.allow.value = true;
    surfaceMocks.surface.authorizeAction.mockClear();
    const typed = await computerUseTool.execute({ action: 'type', text: 'hi' }, context);
    expect(typed.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
    expect(surfaceMocks.surface.authorizeAction).toHaveBeenCalled();
  });

  it('does not refuse click or scroll when a lease exists', async () => {
    const context = makeContext(identity('click'));
    await declareNotes(context);
    const click = await computerUseTool.execute({ action: 'click', x: 4, y: 5 }, context);
    expect(click.metadata?.code).not.toBe('COMPUTER_TARGET_REQUIRED');
    expect(surfaceMocks.surface.authorizeAction).toHaveBeenCalled();
  });

  it('drops the oldest lease past 50 keys', () => {
    const oldest = { sessionId: 'cap-session', turnId: 'cap-turn-oldest', agentId: 'cap-agent' };
    recordTarget(oldest, { action: 'open_application', targetApp: 'Notes' });
    for (let index = 0; index < 50; index += 1) {
      recordTarget(
        { sessionId: 'cap-session', turnId: `cap-turn-${index}`, agentId: 'cap-agent' },
        { action: 'open_application', targetApp: 'Safari' },
      );
    }
    expect(checkLease({ action: 'type' }, oldest)).toBeNull();
    expect(checkLease(
      { action: 'type' },
      { sessionId: 'cap-session', turnId: 'cap-turn-49', agentId: 'cap-agent' },
    )?.code).toBe('COMPUTER_TARGET_REQUIRED');
  });

  it('reads the leased app when the step args omit targetApp', () => {
    const id = { sessionId: 'observe-session', turnId: 'observe-turn', agentId: 'observe-agent' };
    recordTarget(id, { action: 'open_application', targetApp: 'Notes' });
    expect(computerUseObservedTarget('computer_use', { action: 'type', text: 'hi' }, id)).toBe('Notes');
    expect(computerUseObservedTarget('computer_use', { action: 'type', targetApp: 'TextEdit' }, id)).toBe('TextEdit');
    expect(computerUseObservedTarget('Read', { targetApp: 'Notes' }, id)).toBeUndefined();
  });
});
