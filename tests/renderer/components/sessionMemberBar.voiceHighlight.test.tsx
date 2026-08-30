// @vitest-environment jsdom
//
// B4：通话中高亮 activeAgentId（§6.7.7；只展示，点击切换是 Phase 2）。
// N-L6-AGENTVIEW 后：data-voice-active 从成员条 pill 搬到「本会话的代理」面板行上。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const appState = { setWorkbenchCollapsed: vi.fn() };

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));
vi.mock('../../../src/renderer/stores/appStore', () => {
  const useAppStore = (selector: (state: typeof appState) => unknown) => selector(appState);
  useAppStore.getState = () => appState;
  return { useAppStore };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

import { SessionAgentsPanel } from '../../../src/renderer/components/TaskPanel/SessionAgentsPanel';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

function record(id: string, name: string): SwarmRunAgentRecord {
  return {
    runId: 'run-1',
    agentId: id,
    name,
    role: id,
    status: 'running',
    startTime: 1,
    endTime: null,
    durationMs: null,
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    costUsd: 0,
    error: null,
    failureCategory: null,
    filesChanged: [],
  };
}

const run: SwarmRunListItem = {
  id: 'run-1',
  sessionId: 'session-1',
  status: 'running',
  coordinator: 'parallel',
  startedAt: 1,
  endedAt: null,
  durationMs: null,
  totalAgents: 2,
  completedCount: 0,
  failedCount: 0,
  totalCostUsd: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  trigger: 'llm-spawn',
};

function session(): SessionWithMeta {
  return {
    id: 'session-1',
    title: '团队会话',
    modelConfig: { provider: 'test', model: 'test-model' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
  };
}

describe('SessionAgentsPanel 通话高亮（B4）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([run]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
        return Promise.resolve({
          run: { ...run, totalToolCalls: 0, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
          agents: [record('qinghe', '青禾'), record('mingjing', '明镜')],
          events: [],
        } satisfies SwarmRunDetail);
      }
      return Promise.resolve(null);
    });
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    useSwarmStore.setState({ activeSessionId: 'session-1', activeRunId: undefined, activeTreeId: undefined, lastEventAt: undefined, eventLog: [] });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useSessionStore.setState({ sessions: [session()], currentSessionId: 'session-1' });
    useMemberViewStore.setState({ viewingMemberId: null });
    useBackgroundTaskStore.setState({ tasks: [] });
    useVoiceCallStore.getState().reset();
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': false },
    });
  });

  afterEach(() => cleanup());

  it('live 通话中高亮 activeAgentId 对应面板行，其他行不亮', async () => {
    useVoiceCallStore.getState().dialStarted('session-1', 'mingjing', 'server_vad');
    useVoiceCallStore.getState().phaseChanged('live');

    render(<SessionAgentsPanel />);

    await waitFor(() => expect(screen.getByTestId('agents-panel-row-mingjing').dataset.voiceActive).toBe('true'));
    expect(screen.getByTestId('agents-panel-row-qinghe').dataset.voiceActive).toBeUndefined();
  });

  it('通话结束（idle）后高亮消失', async () => {
    useVoiceCallStore.getState().dialStarted('session-1', 'mingjing', 'server_vad');
    useVoiceCallStore.getState().phaseChanged('live');
    const { rerender } = render(<SessionAgentsPanel />);
    await waitFor(() => expect(screen.getByTestId('agents-panel-row-mingjing').dataset.voiceActive).toBe('true'));

    useVoiceCallStore.getState().reset();
    rerender(<SessionAgentsPanel />);
    expect(screen.getByTestId('agents-panel-row-mingjing').dataset.voiceActive).toBeUndefined();
  });
});
