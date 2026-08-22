// @vitest-environment jsdom
// ============================================================================
// teamLead 标记（N-L6-AGENTVIEW 后）：member-lead-badge 从成员条 pill 搬到
// 「本会话的代理」面板的专家行上，断言对象随之迁到 SessionAgentsPanel。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import type {
  SwarmRunAgentRecord,
  SwarmRunDetail,
  SwarmRunListItem,
} from '../../../src/shared/contract/swarmTrace';
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
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

const persistedAgents: SwarmRunAgentRecord[] = [
  {
    runId: 'run-1',
    agentId: 'researcher',
    name: '调研员',
    role: 'researcher',
    status: 'completed',
    startTime: 1,
    endTime: 4_001,
    durationMs: 4_000,
    tokensIn: 12,
    tokensOut: 34,
    toolCalls: 5,
    costUsd: 0.002,
    error: null,
    failureCategory: null,
    filesChanged: [],
  },
  {
    runId: 'run-1',
    agentId: 'writer',
    name: '撰稿员',
    role: 'writer',
    status: 'completed',
    startTime: 2,
    endTime: 5_001,
    durationMs: 3_000,
    tokensIn: 56,
    tokensOut: 78,
    toolCalls: 6,
    costUsd: 0.003,
    error: null,
    failureCategory: null,
    filesChanged: [],
  },
];

const run: SwarmRunListItem = {
  id: 'run-1',
  sessionId: 'session-1',
  status: 'completed',
  coordinator: 'parallel',
  startedAt: 1,
  endedAt: 5_001,
  durationMs: 5_000,
  totalAgents: 2,
  completedCount: 2,
  failedCount: 0,
  totalCostUsd: 0.005,
  totalTokensIn: 68,
  totalTokensOut: 112,
  trigger: 'llm-spawn',
};

function session(metadata?: Record<string, unknown>): SessionWithMeta {
  return {
    id: 'session-1',
    title: '团队会话',
    modelConfig: { provider: 'test', model: 'test-model' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    metadata,
  };
}

function mockPersistedLedger(): void {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([run]);
    if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
      return Promise.resolve({
        run: { ...run, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
        agents: persistedAgents,
        events: [],
      } satisfies SwarmRunDetail);
    }
    return Promise.resolve(null);
  });
}

function expectOnlyLead(roleId: string): void {
  expect(screen.getByTestId(`member-lead-badge-${roleId}`).textContent).toBe('牵头专家');
  for (const other of ['researcher', 'writer', '牧之', '溯真'].filter((id) => id !== roleId)) {
    expect(screen.queryByTestId(`member-lead-badge-${other}`)).toBeNull();
  }
}

describe('SessionAgentsPanel team lead marker', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    useSwarmStore.setState({ activeSessionId: undefined, activeRunId: undefined, activeTreeId: undefined, lastEventAt: undefined, eventLog: [] });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useSessionStore.setState({ sessions: [session()], currentSessionId: 'session-1' });
    useMemberViewStore.setState({ viewingMemberId: null });
    useBackgroundTaskStore.setState({ tasks: [] });
  });

  afterEach(() => cleanup());

  it('运行中账本按 metadata.teamLead.roleId 标记对应面板行', async () => {
    mockPersistedLedger();
    useSessionStore.setState({
      sessions: [session({
        teamLead: { roleId: 'writer', recipeId: 'recipe-1', setAt: 10 },
      })],
    });

    render(<SessionAgentsPanel />);

    await waitFor(() => expect(screen.getByTestId('agents-panel-row-writer')).toBeTruthy());
    expectOnlyLead('writer');
  });

  it('持久化账本回灌按 metadata.teamLead.roleId 标记对应面板行', async () => {
    mockPersistedLedger();
    useSessionStore.setState({
      sessions: [session({
        teamLead: { roleId: 'researcher', recipeId: 'recipe-1', setAt: 10 },
      })],
    });

    render(<SessionAgentsPanel />);

    await waitFor(() => expect(screen.getByTestId('agents-panel-row-researcher')).toBeTruthy());
    expectOnlyLead('researcher');
  });

  it('预选配方名单也只按 metadata.teamLead.roleId 标记对应面板行', async () => {
    useTeamRecipeStore.setState({
      recipes: [{
        id: 'recipe-1',
        name: '上线评审',
        description: '',
        category: 'product',
        lead: { roleId: '牧之', briefTemplate: '统筹 {topic}' },
        members: [{ roleId: '溯真', taskTemplate: '调研 {topic}' }],
      }],
      isLoaded: true,
    });
    useComposerStore.setState({ selectedTeamRecipeId: 'recipe-1' });
    useSessionStore.setState({
      sessions: [session({
        teamLead: { roleId: '牧之', recipeId: 'recipe-1', setAt: 10 },
      })],
    });

    render(<SessionAgentsPanel />);

    await waitFor(() => expect(screen.getByTestId('member-standby-remove-牧之')).toBeTruthy());
    expectOnlyLead('牧之');
  });

  it('没有 teamLead metadata 时不标记任何行，不默认第一个成员', async () => {
    mockPersistedLedger();

    const { container } = render(<SessionAgentsPanel />);

    await waitFor(() => expect(screen.getByTestId('agents-panel-row-researcher')).toBeTruthy());
    expect(container.querySelectorAll('[data-testid^="member-lead-badge-"]')).toHaveLength(0);
  });
});
