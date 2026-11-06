// @vitest-environment jsdom
// ============================================================================
// AgentTeamPanel 消息时间戳口径（N-CRON-DETAIL-TIME-FORMAT-MIXED-FU1 返修）：
// MessageItem 头部的裸 toLocaleTimeString 改走 utils/formatDateTime(ts, language)，
// zh 24 小时制带年份、绝不跟机器 locale 出 AM/PM；en 维持 en-US 原样。
// 消息经 swarmStore.handleEvent 注入（同 agentTeamPanel.scope.test.tsx 的注入口）。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmEvent } from '../../../src/shared/contract/swarm';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: invokeMock,
    invokeDomain: vi.fn(),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { AgentTeamPanel } from '../../../src/renderer/components/features/agentTeam/AgentTeamPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';

// 本地时区构造（不跨时区换算），任何 TZ 下时分字段都是构造值本身。
const MESSAGE_AT = new Date(2026, 10, 9, 16, 5, 0).getTime(); // 2026-11-09 16:05
const ZH = '2026/11/09 16:05';
const EN = '11/9/2026, 4:05:00 PM';

const AGENT_ID = 'reviewer';

function event(
  type: SwarmEvent['type'],
  sessionId: string,
  runId: string,
  data: SwarmEvent['data'],
  timestamp: number,
): SwarmEvent {
  return { type, sessionId, runId, treeId: `tree-${runId}`, timestamp, data };
}

// 面板在 agents.length === 0 && !isRunning 时渲染空态、不出消息——先种一个 run + agent。
function seedRun(sessionId: string, runId: string, timestamp: number): void {
  const store = useSwarmStore.getState();
  store.handleEvent(event('swarm:started', sessionId, runId, {}, timestamp));
  store.handleEvent(event('swarm:agent:added', sessionId, runId, {
    agentId: AGENT_ID,
    agentState: {
      id: AGENT_ID,
      name: `Reviewer ${sessionId}`,
      role: 'reviewer',
      status: 'running',
      iterations: 0,
    },
  }, timestamp + 1));
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useSwarmStore.getState().reset();
  useSwarmStore.getState().activateScope('session-a', 'run-a');
  seedRun('session-a', 'run-a', MESSAGE_AT - 1000);
  useSwarmStore.getState().handleEvent(event('swarm:user:message', 'session-a', 'run-a', {
    agentId: AGENT_ID,
    message: {
      id: 'user-message-1',
      from: 'user',
      to: AGENT_ID,
      content: '同步一下进度',
      messageType: 'user',
    },
  }, MESSAGE_AT));
  useAppStore.setState({ language: 'zh' });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  useSwarmStore.getState().reset();
});

describe('AgentTeamPanel 消息时间戳（跟随 UI language）', () => {
  it('zh UI：消息时间为 24 小时制带年份，无 AM/PM', async () => {
    render(<AgentTeamPanel sessionId="session-a" runId="run-a" />);
    await screen.findByText('同步一下进度');
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain(ZH);
    });
    expect(document.body.textContent ?? '').not.toMatch(/AM|PM/);
  });

  it('en UI：维持 en-US 原样（英文 UI 行为不变）', async () => {
    useAppStore.setState({ language: 'en' });
    render(<AgentTeamPanel sessionId="session-a" runId="run-a" />);
    await screen.findByText('同步一下进度');
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain(EN);
    });
    expect(document.body.textContent ?? '').not.toContain('16:05');
  });
});
