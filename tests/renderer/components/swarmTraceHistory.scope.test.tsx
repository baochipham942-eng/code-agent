// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: invokeMock,
  default: { invoke: invokeMock },
}));

import { SwarmTraceHistory } from '../../../src/renderer/components/features/swarm/SwarmTraceHistory';

function run(id: string, sessionId: string): SwarmRunListItem {
  return {
    id,
    sessionId,
    status: 'completed',
    coordinator: 'parallel',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    totalAgents: 1,
    completedCount: 1,
    failedCount: 0,
    totalCostUsd: 0,
    totalTokensIn: 1,
    totalTokensOut: 1,
    trigger: 'llm-spawn',
  };
}

describe('SwarmTraceHistory session scope', () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(() => cleanup());

  it('drops a late foreign-session list and scopes list/detail calls to the active session', async () => {
    let resolveSessionA: ((runs: SwarmRunListItem[]) => void) | undefined;
    invokeMock.mockImplementation((channel: string, payload: { sessionId: string }) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS && payload.sessionId === 'session-a') {
        return new Promise<SwarmRunListItem[]>((resolve) => { resolveSessionA = resolve; });
      }
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS && payload.sessionId === 'session-b') {
        return Promise.resolve([run('run-b-opaque', 'session-b')]);
      }
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) {
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });

    const view = render(<SwarmTraceHistory sessionId="session-a" />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_LIST_TRACE_RUNS, {
        sessionId: 'session-a',
        limit: 20,
      });
    });

    view.rerender(<SwarmTraceHistory sessionId="session-b" />);
    await waitFor(() => expect(view.getByText('run-b-op')).toBeTruthy());

    await act(async () => {
      resolveSessionA?.([run('run-a-opaque', 'session-a')]);
      await Promise.resolve();
    });
    expect(view.queryByText('run-a-op')).toBeNull();

    fireEvent.click(view.getByText('run-b-op'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL, {
        sessionId: 'session-b',
        runId: 'run-b-opaque',
      });
    });
  });
});
