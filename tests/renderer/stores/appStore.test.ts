// ============================================================================
// appStore.test.ts - Global app store tests for orchestration selection state
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function permissionRequest(id: string): PermissionRequest {
  return {
    id,
    type: 'command',
    tool: 'shell',
    details: { command: `echo ${id}` },
    timestamp: 100,
  };
}

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedSwarmAgentId: null,
      showAgentTeamPanel: false,
      taskPanelTab: 'monitor',
      showSettings: false,
      settingsInitialTab: null,
      settingsMemoryFocus: null,
      settingsCapabilityFocus: null,
      showKnowledgeMemoryPanel: false,
      optionalUpdateInfo: null,
      showOptionalUpdateModal: false,
      goalRuns: {},
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
    });
  });

  it('tracks the selected swarm agent id', () => {
    expect(useAppStore.getState().selectedSwarmAgentId).toBeNull();

    useAppStore.getState().setSelectedSwarmAgentId('agent-alpha');

    expect(useAppStore.getState().selectedSwarmAgentId).toBe('agent-alpha');
  });

  it('clears the selected swarm agent id when set to null', () => {
    useAppStore.getState().setSelectedSwarmAgentId('agent-beta');
    useAppStore.getState().setSelectedSwarmAgentId(null);

    expect(useAppStore.getState().selectedSwarmAgentId).toBeNull();
  });

  it('setGoalPaused 在 running↔paused 间切换（③ session 内暂停）', () => {
    const s = useAppStore.getState();
    s.startGoalRun('sess-pause-1', { goal: '长任务' });
    s.setGoalPaused('sess-pause-1', true);
    expect(useAppStore.getState().goalRuns['sess-pause-1']?.status).toBe('paused');
    s.setGoalPaused('sess-pause-1', false);
    expect(useAppStore.getState().goalRuns['sess-pause-1']?.status).toBe('running');
  });

  it('setGoalPaused 不覆盖已完成/中止的 goal', () => {
    const s = useAppStore.getState();
    s.startGoalRun('sess-pause-2', { goal: '短任务' });
    s.finishGoalRun('sess-pause-2', 'met');
    s.setGoalPaused('sess-pause-2', true);
    expect(useAppStore.getState().goalRuns['sess-pause-2']?.status).toBe('met');
  });

  it('keeps goal gate history with verification cards', () => {
    const s = useAppStore.getState();
    s.startGoalRun('sess-verification-card', { goal: '验证目标' });
    s.recordGoalGate('sess-verification-card', {
      gate: 1,
      pass: false,
      verificationCard: {
        status: 'failed',
        failureType: 'test',
        summary: 'test failed',
        counts: { passed: 1, failed: 1, notRun: 0, total: 2 },
        requiredStatus: 'failed',
        commands: [],
        evidenceRefIds: ['evidence_test'],
        skippedChecks: [],
      },
    });

    const run = useAppStore.getState().goalRuns['sess-verification-card'];
    expect(run?.lastGate?.verificationCard?.status).toBe('failed');
    expect(run?.gates).toHaveLength(1);
    expect(run?.gates[0]?.verificationCard?.evidenceRefIds).toEqual(['evidence_test']);
  });

  it('opens memory settings with an optional detail focus', () => {
    useAppStore.getState().openMemorySettings({
      filename: 'project.md',
      query: 'project.md',
    });

    const state = useAppStore.getState();
    expect(state.showSettings).toBe(true);
    expect(state.settingsInitialTab).toBe('memory');
    expect(state.settingsMemoryFocus).toMatchObject({
      filename: 'project.md',
      query: 'project.md',
    });
    expect(state.settingsMemoryFocus?.nonce).toEqual(expect.any(Number));
  });

  it('clears memory detail focus when opening a regular settings tab', () => {
    useAppStore.getState().openMemorySettings({ filename: 'project.md' });
    useAppStore.getState().openSettingsTab('general');

    expect(useAppStore.getState()).toMatchObject({
      showSettings: true,
      settingsInitialTab: 'general',
      settingsMemoryFocus: null,
      settingsCapabilityFocus: null,
    });
  });

  it('opens capability settings with a typed focus target', () => {
    useAppStore.getState().openCapabilitySettingsTarget({ kind: 'mcp', id: 'github' });

    expect(useAppStore.getState()).toMatchObject({
      showSettings: true,
      settingsInitialTab: 'mcp',
      settingsMemoryFocus: null,
      settingsCapabilityFocus: {
        kind: 'mcp',
        id: 'github',
        nonce: expect.any(Number),
      },
    });

    useAppStore.getState().openCapabilitySettingsTarget({ kind: 'skill', id: 'review-skill' });

    expect(useAppStore.getState()).toMatchObject({
      showSettings: true,
      settingsInitialTab: 'skills',
      settingsCapabilityFocus: {
        kind: 'skill',
        id: 'review-skill',
        nonce: expect.any(Number),
      },
    });
  });

  it('opens the knowledge memory panel outside settings and closes computer use', () => {
    useAppStore.setState({ showComputerUsePanel: true });
    useAppStore.getState().setShowKnowledgeMemoryPanel(true);

    expect(useAppStore.getState()).toMatchObject({
      showKnowledgeMemoryPanel: true,
      showComputerUsePanel: false,
    });
  });

  it('stores optional update info for the title bar and settings badge', () => {
    useAppStore.getState().setOptionalUpdateInfo({
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '0.16.75',
      latestVersion: '0.16.76',
      releaseNotes: 'Bug fixes',
    });

    expect(useAppStore.getState().optionalUpdateInfo).toMatchObject({
      hasUpdate: true,
      currentVersion: '0.16.75',
      latestVersion: '0.16.76',
    });

    useAppStore.getState().setOptionalUpdateInfo(null);

    expect(useAppStore.getState().optionalUpdateInfo).toBeNull();
  });

  it('tracks the optional update modal separately from update availability', () => {
    expect(useAppStore.getState().showOptionalUpdateModal).toBe(false);

    useAppStore.getState().setShowOptionalUpdateModal(true);

    expect(useAppStore.getState().showOptionalUpdateModal).toBe(true);
  });

  it('clears pending and queued permissions only for the requested session', () => {
    const pending = permissionRequest('current-pending');
    const currentQueued = permissionRequest('current-queued');
    const foreign = permissionRequest('foreign');
    const global = permissionRequest('global');
    useAppStore.setState({
      pendingPermissionRequest: pending,
      pendingPermissionSessionId: 'session-current',
      queuedPermissionRequests: {
        'session-current': [currentQueued],
        'session-foreign': [foreign],
        global: [global],
      },
    });

    useAppStore.getState().clearPermissionRequestsForSession('session-current');

    expect(useAppStore.getState()).toMatchObject({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {
        'session-foreign': [foreign],
        global: [global],
      },
    });
  });

  it('clears global permission state only for the global pseudo session', () => {
    const globalPending = permissionRequest('global-pending');
    const globalQueued = permissionRequest('global-queued');
    const foreign = permissionRequest('foreign');
    useAppStore.setState({
      pendingPermissionRequest: globalPending,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {
        global: [globalQueued],
        'session-foreign': [foreign],
      },
    });

    useAppStore.getState().clearPermissionRequestsForSession('global');

    expect(useAppStore.getState()).toMatchObject({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: { 'session-foreign': [foreign] },
    });
  });
});
