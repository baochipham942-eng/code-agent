// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const listRoles = vi.fn<() => Promise<RolePanelEntry[]>>();
const invokeMock = vi.fn();
const appState = { activeAgentId: 'muzhi', openExpertRoleDetail: vi.fn(), openWorkspacePreview: vi.fn() };
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined } = { agents: [], activeSessionId: undefined };
const sessionState = { sessions: [{ id: 'session-1', title: '产品诊断' }] };

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/services/rolesClient', () => ({ listRoles: () => listRoles() }));
vi.mock('../../../src/renderer/stores/appStore', () => ({ useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState) }));
// 工厂在组件 import 时求值，早于 const 初始化：必须延迟解引用（其余 mock 都是调用时才取）
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: (...args: unknown[]) => invokeMock(...args) } }));

import { SessionAgentIdentityBar, swarmRunAgentRecordToState } from '../../../src/renderer/components/features/expert/SessionAgentIdentityBar';

const agents: SwarmRunAgentRecord[] = [
  { runId: 'run-1', agentId: 'researcher', name: '调研员', role: 'researcher', status: 'completed', startTime: 1, endTime: 4_001, durationMs: 4_000, tokensIn: 12, tokensOut: 34, toolCalls: 5, costUsd: 0.002, error: null, failureCategory: null, filesChanged: [], dispatchedTask: '核对数据', finalOutput: `${'完整持久化产出'.repeat(40)} 收尾证据` },
  { runId: 'run-1', agentId: 'writer', name: '撰稿员', role: 'writer', status: 'completed', startTime: 2, endTime: 5_001, durationMs: 3_000, tokensIn: 56, tokensOut: 78, toolCalls: 6, costUsd: 0.003, error: null, failureCategory: null, filesChanged: [] },
];

const run: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'completed', coordinator: 'parallel', startedAt: 1, endedAt: 5_001, durationMs: 5_000,
  totalAgents: 2, completedCount: 2, failedCount: 0, totalCostUsd: 0.005, totalTokensIn: 68, totalTokensOut: 112, trigger: 'llm-spawn',
};

describe('SessionAgentIdentityBar', () => {
  beforeEach(() => {
    appState.activeAgentId = 'muzhi';
    swarmState.agents = [];
    swarmState.activeSessionId = undefined;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    listRoles.mockResolvedValue([{ roleId: 'muzhi', displayName: '牧之', profession: '资深产品经理', description: '', source: 'builtin', memoryCount: 0, lastWork: null }]);
  });
  afterEach(() => cleanup());

  it('单专家会话不渲染顶部身份条', async () => {
    render(<SessionAgentIdentityBar sessionId="session-1" />);
    await Promise.resolve();
    expect(screen.queryByTestId('session-agent-identity')).toBeNull();
  });

  it('普通未绑定会话不渲染身份条', async () => {
    appState.activeAgentId = null as unknown as string;
    render(<SessionAgentIdentityBar sessionId="session-1" />);
    await Promise.resolve();
    expect(screen.queryByTestId('session-agent-identity')).toBeNull();
  });

  it('空内存时回灌最近团队 run，渲染身份条并可打开完整工作记录', async () => {
    const detail: SwarmRunDetail = { run: { ...run, totalTokensIn: 68, totalTokensOut: 112, totalToolCalls: 11, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] }, agents, events: [] };
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([run]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(detail);
      return Promise.resolve(null);
    });

    render(<SessionAgentIdentityBar sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('session-team-identity')).toBeTruthy());
    expect(screen.getByTestId('role-initial-avatar-researcher')).toBeTruthy();
    expect(screen.getByTestId('role-initial-avatar-writer')).toBeTruthy();

    fireEvent.click(screen.getByTestId('role-initial-avatar-researcher'));
    expect(await screen.findByTestId('agent-work-record')).toBeTruthy();
    expect(screen.getByTestId('agent-work-output').textContent).toContain('收尾证据');
    expect(screen.getByTestId('agent-work-output').textContent?.length).toBeGreaterThan(200);
  });

  it('实时团队优先，不读取持久化 run', async () => {
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = agents.map(swarmRunAgentRecordToState);

    render(<SessionAgentIdentityBar sessionId="session-1" />);
    expect(screen.getByTestId('session-team-identity')).toBeTruthy();
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalledWith(IPC_CHANNELS.SWARM_LIST_TRACE_RUNS, expect.anything());
  });

  it('把持久化成员记录映射为工作记录所需的实时状态', () => {
    expect(swarmRunAgentRecordToState(agents[0])).toMatchObject({
      id: 'researcher', name: '调研员', role: 'researcher', status: 'completed', startTime: 1, endTime: 4_001,
      tokenUsage: { input: 12, output: 34 }, toolCalls: 5, cost: 0.002, finalOutput: expect.stringContaining('收尾证据'),
    });
  });
});
