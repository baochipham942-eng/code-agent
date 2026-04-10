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
});
