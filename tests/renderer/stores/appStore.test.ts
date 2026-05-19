// ============================================================================
// appStore.test.ts - Global app store tests for orchestration selection state
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedSwarmAgentId: null,
      showAgentTeamPanel: false,
      showTaskPanel: true,
      taskPanelTab: 'monitor',
      showSettings: false,
      settingsInitialTab: null,
      settingsMemoryFocus: null,
      showKnowledgeMemoryPanel: false,
      optionalUpdateInfo: null,
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
});
