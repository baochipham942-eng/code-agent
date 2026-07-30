// @vitest-environment jsdom
//
// B4：通话中成员条高亮 activeAgentId（§6.7.7；只展示，点击切换是 Phase 2）。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined } = {
  agents: [],
  activeSessionId: undefined,
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: (...args: unknown[]) => invokeMock(...args) },
}));

import { SessionMemberBar } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

function agent(id: string, name: string): SwarmAgentState {
  return {
    id,
    name,
    role: id,
    status: 'running',
    startTime: 1,
    iterations: 0,
    tokenUsage: { input: 0, output: 0 },
    toolCalls: 0,
  };
}

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

describe('SessionMemberBar 通话高亮（B4）', () => {
  beforeEach(() => {
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = [agent('qinghe', '青禾'), agent('mingjing', '明镜')];
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
    useComposerStore.setState({ selectedTeamRecipeId: null });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useSessionStore.setState({ sessions: [session()], currentSessionId: 'session-1' });
    useMemberViewStore.setState({ viewingMemberId: null });
    useVoiceCallStore.getState().reset();
  });

  afterEach(() => cleanup());

  it('live 通话中高亮 activeAgentId 对应 pill，其他 pill 不亮', async () => {
    useVoiceCallStore.getState().dialStarted('session-1', 'mingjing', 'server_vad');
    useVoiceCallStore.getState().phaseChanged('live');

    render(<SessionMemberBar sessionId="session-1" />);

    await waitFor(() => expect(screen.getByTestId('member-pill-mingjing').dataset.voiceActive).toBe('true'));
    expect(screen.getByTestId('member-pill-qinghe').dataset.voiceActive).toBeUndefined();
  });

  it('通话结束（idle）后高亮消失', async () => {
    useVoiceCallStore.getState().dialStarted('session-1', 'mingjing', 'server_vad');
    useVoiceCallStore.getState().phaseChanged('live');
    const { rerender } = render(<SessionMemberBar sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-pill-mingjing').dataset.voiceActive).toBe('true'));

    useVoiceCallStore.getState().reset();
    rerender(<SessionMemberBar sessionId="session-1" />);
    expect(screen.getByTestId('member-pill-mingjing').dataset.voiceActive).toBeUndefined();
  });
});
