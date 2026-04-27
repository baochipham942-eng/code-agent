import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  SwarmEvent,
  SwarmAgentState,
  SwarmLaunchRequest,
} from '../../../src/shared/contract/swarm';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  off: vi.fn(),
}));

import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';

function agent(id: string, overrides: Partial<SwarmAgentState> = {}): SwarmAgentState {
  return {
    id,
    name: `Agent ${id}`,
    role: 'worker',
    status: 'pending',
    iterations: 0,
    ...overrides,
  };
}

function evt<T extends SwarmEvent['type']>(
  type: T,
  data: SwarmEvent['data'],
  timestamp = Date.now(),
  sessionId?: string,
  runId?: string,
): SwarmEvent {
  return { type, timestamp, data, sessionId, runId } as SwarmEvent;
}

function launchRequest(id: string): SwarmLaunchRequest {
  return {
    id,
    sessionId: 'session-1',
    status: 'pending',
    summary: 'test swarm',
    requestedAt: 1000,
    agentCount: 1,
    dependencyCount: 0,
    writeAgentCount: 0,
    tasks: [
      { id: 't1', role: 'worker', task: 'task 1', tools: [], writeAccess: false },
    ],
  };
}

describe('swarmStore', () => {
  beforeEach(() => {
    useSwarmStore.getState().reset();
  });

  describe('launch lifecycle', () => {
    it('launch:requested 将 store 切到 waiting_approval 并塞入 launchRequests', () => {
      const store = useSwarmStore.getState();
      const req = launchRequest('req-1');

      store.handleEvent(evt('swarm:launch:requested', { launchRequest: req }, 1000));

      const state = useSwarmStore.getState();
      expect(state.executionPhase).toBe('waiting_approval');
      expect(state.launchRequests).toHaveLength(1);
      expect(state.launchRequests[0].id).toBe('req-1');
      expect(state.lastEventAt).toBe(1000);
      expect(state.eventLog).toHaveLength(1);
      expect(state.eventLog[0].tone).toBe('warning');
    });

    it('preserves sessionId on launch requests and timeline events', () => {
      const store = useSwarmStore.getState();
      const req = launchRequest('req-session');

      store.handleEvent(evt('swarm:launch:requested', { launchRequest: req }, 1000, 'session-1'));

      const state = useSwarmStore.getState();
      expect(state.launchRequests[0]?.sessionId).toBe('session-1');
      expect(state.eventLog[0]?.sessionId).toBe('session-1');
    });

    it('launch:rejected 在新 requested 前会被旧记录覆盖（reset 语义）', () => {
      const store = useSwarmStore.getState();
      const req1 = { ...launchRequest('req-1'), status: 'rejected' as const };
      const req2 = launchRequest('req-2');

      store.handleEvent(evt('swarm:launch:requested', { launchRequest: req1 }, 1000));
      store.handleEvent(evt('swarm:launch:rejected', { launchRequest: req1 }, 1100));
      store.handleEvent(evt('swarm:launch:requested', { launchRequest: req2 }, 1200));

      const state = useSwarmStore.getState();
      expect(state.launchRequests).toHaveLength(1);
      expect(state.launchRequests[0].id).toBe('req-2');
      expect(state.executionPhase).toBe('waiting_approval');
    });

    it('started 将 isRunning 置 true 并 reset 其它字段', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:launch:requested', { launchRequest: launchRequest('req-1') }));

      store.handleEvent(
        evt('swarm:started', { statistics: { total: 3, completed: 0, failed: 0, running: 0, pending: 3, parallelPeak: 0, totalTokens: 0, totalToolCalls: 0 } }, 2000),
      );

      const state = useSwarmStore.getState();
      expect(state.isRunning).toBe(true);
      expect(state.startTime).toBe(2000);
      expect(state.statistics.total).toBe(3);
      expect(state.launchRequests).toHaveLength(0);
    });
  });

  describe('agent upserts', () => {
    it('agent:added 追加 agent，重复 id 走 merge 不产生副本', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1', { status: 'ready' }) }));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1', { status: 'running', iterations: 2 }) }));

      const state = useSwarmStore.getState();
      expect(state.agents).toHaveLength(1);
      expect(state.agents[0].status).toBe('running');
      expect(state.agents[0].iterations).toBe(2);
    });

    it('statistics 基于 agent 状态重算，parallelPeak 单调递增', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1', { status: 'running' }) }));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a2', { status: 'running' }) }));
      store.handleEvent(evt('swarm:agent:updated', { agentState: agent('a1', { status: 'completed' }) }));

      const state = useSwarmStore.getState();
      expect(state.statistics.running).toBe(1);
      expect(state.statistics.completed).toBe(1);
      expect(state.statistics.parallelPeak).toBe(2);
    });

    it('executionPhase 在有 running agent 时为 executing', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1', { status: 'running' }) }));

      expect(useSwarmStore.getState().executionPhase).toBe('executing');
    });
  });

  describe('agent completion', () => {
    it('agent:completed 追加 CompletedAgentRun，保留上限 10 条', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));

      for (let i = 0; i < 12; i += 1) {
        const a = agent(`a${i}`, {
          status: 'completed',
          startTime: 1000,
          endTime: 2000,
          tokenUsage: { input: 10, output: 20 },
          toolCalls: 1,
          resultPreview: `result-${i}`,
        });
        store.handleEvent(evt('swarm:agent:completed', { agentState: a }));
      }

      const state = useSwarmStore.getState();
      expect(state.completedRuns).toHaveLength(10);
      expect(state.completedRuns[0].id).toBe('a2');
      expect(state.completedRuns[9].id).toBe('a11');
      expect(state.completedRuns[9].durationMs).toBe(1000);
    });

    it('agent:failed 走失败状态并记入 completedRuns', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(
        evt('swarm:agent:failed', {
          agentState: agent('a1', { status: 'failed', error: 'boom', startTime: 1, endTime: 2 }),
        }),
      );

      const state = useSwarmStore.getState();
      expect(state.statistics.failed).toBe(1);
      expect(state.completedRuns).toHaveLength(1);
      expect(state.completedRuns[0].status).toBe('failed');
    });

    it('agent:failed 携带 cancelled 状态时记入 cancelled completedRun', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(
        evt('swarm:agent:failed', {
          agentState: agent('a1', { status: 'cancelled', error: 'Cancelled by user', startTime: 1, endTime: 2 }),
        }),
      );

      const state = useSwarmStore.getState();
      expect(state.statistics.failed).toBe(1);
      expect(state.completedRuns).toHaveLength(1);
      expect(state.completedRuns[0].status).toBe('cancelled');
    });
  });

  describe('plan review', () => {
    it('plan_review → plan_approved 翻转同一条记录的状态', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(
        evt('swarm:agent:plan_review', {
          agentId: 'a1',
          plan: { id: 'plan-1', agentId: 'a1', content: '草案', status: 'pending' },
        }, 3000),
      );
      store.handleEvent(
        evt('swarm:agent:plan_approved', {
          agentId: 'a1',
          plan: { id: 'plan-1', agentId: 'a1', content: '草案', status: 'approved', feedback: '赞' },
        }, 3100),
      );

      const state = useSwarmStore.getState();
      expect(state.planReviews).toHaveLength(1);
      expect(state.planReviews[0].status).toBe('approved');
      expect(state.planReviews[0].feedback).toBe('赞');
      expect(state.planReviews[0].resolvedAt).toBe(3100);
    });

    it('plan_rejected 不带 id 时按 agentId fallback 匹配最近 pending', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(
        evt('swarm:agent:plan_review', {
          agentId: 'a1',
          plan: { id: 'plan-1', agentId: 'a1', content: 'v1' },
        }),
      );
      store.handleEvent(
        evt('swarm:agent:plan_rejected', {
          agentId: 'a1',
          plan: { agentId: 'a1', content: 'v1', feedback: 'no' },
        }),
      );

      const state = useSwarmStore.getState();
      expect(state.planReviews[0].status).toBe('rejected');
      expect(state.planReviews[0].feedback).toBe('no');
    });
  });

  describe('messages & event log', () => {
    it('agent:message 追加到 messages，超过 40 条滚动', () => {
      const store = useSwarmStore.getState();
      for (let i = 0; i < 45; i += 1) {
        store.handleEvent(
          evt('swarm:agent:message', {
            message: { from: 'a1', to: 'a2', content: `m${i}`, messageType: 'coordination' },
          }, 1000 + i),
        );
      }

      const state = useSwarmStore.getState();
      expect(state.messages).toHaveLength(40);
      expect(state.messages[0].content).toBe('m5');
      expect(state.messages[39].content).toBe('m44');
    });

    it('eventLog 上限 80 条，先进先出', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      for (let i = 0; i < 100; i += 1) {
        store.handleEvent(
          evt('swarm:agent:added', { agentState: agent(`a${i}`, { status: 'ready' }) }, 2000 + i),
        );
      }
      expect(useSwarmStore.getState().eventLog.length).toBeLessThanOrEqual(80);
    });

    it('带 session/run 身份的外部事件不会混入当前 session store', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(
        evt('swarm:started', {
          statistics: {
            total: 1,
            completed: 0,
            failed: 0,
            running: 0,
            pending: 1,
            parallelPeak: 0,
            totalTokens: 0,
            totalToolCalls: 0,
          },
        }, 1000, 'session-1', 'run-1'),
      );
      store.handleEvent(
        evt('swarm:user:message', {
          agentId: 'a1',
          message: { from: 'user', to: 'a1', content: 'same session' },
        }, 1010, 'session-1', 'run-1'),
      );
      store.handleEvent(
        evt('swarm:user:message', {
          agentId: 'b1',
          message: { from: 'user', to: 'b1', content: 'other session' },
        }, 1020, 'session-2', 'run-2'),
      );

      const state = useSwarmStore.getState();
      expect(state.activeSessionId).toBe('session-1');
      expect(state.activeRunId).toBe('run-1');
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe('same session');
      expect(state.eventLog.some((entry) => entry.sessionId === 'session-2')).toBe(false);
    });

    it('新 root 事件切换身份时重置旧 session 状态，避免跨 session 拼接', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}, 1000, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1') }, 1010, 'session-1', 'run-1'));

      store.handleEvent(
        evt('swarm:started', {
          statistics: {
            total: 2,
            completed: 0,
            failed: 0,
            running: 0,
            pending: 2,
            parallelPeak: 0,
            totalTokens: 0,
            totalToolCalls: 0,
          },
        }, 2000, 'session-2', 'run-2'),
      );

      const state = useSwarmStore.getState();
      expect(state.activeSessionId).toBe('session-2');
      expect(state.activeRunId).toBe('run-2');
      expect(state.agents).toHaveLength(0);
      expect(state.statistics.total).toBe(2);
      expect(state.eventLog).toHaveLength(1);
      expect(state.eventLog[0].sessionId).toBe('session-2');
    });

    it('切换 root 后保留旧 session/run 的 agents/messages/eventLog/completedRuns 快照', () => {
      const store = useSwarmStore.getState();

      store.handleEvent(evt('swarm:started', {}, 1000, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:agent:added', {
        agentState: agent('a1', { status: 'running', startTime: 1000 }),
      }, 1010, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:user:message', {
        agentId: 'a1',
        message: { from: 'user', to: 'a1', content: 'check old run' },
      }, 1020, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:agent:completed', {
        agentState: agent('a1', {
          status: 'completed',
          startTime: 1000,
          endTime: 1100,
          resultPreview: 'old result',
        }),
      }, 1030, 'session-1', 'run-1'));

      store.handleEvent(evt('swarm:started', {}, 2000, 'session-2', 'run-2'));

      const state = useSwarmStore.getState();
      const oldSnapshot = state.runSnapshots['session-1::run-1'];

      expect(state.activeSessionId).toBe('session-2');
      expect(state.activeRunId).toBe('run-2');
      expect(state.agents).toHaveLength(0);
      expect(oldSnapshot.sessionId).toBe('session-1');
      expect(oldSnapshot.runId).toBe('run-1');
      expect(oldSnapshot.agents.map((a) => a.id)).toEqual(['a1']);
      expect(oldSnapshot.messages[0]?.content).toBe('check old run');
      expect(oldSnapshot.eventLog.some((entry) => entry.type === 'swarm:agent:completed')).toBe(true);
      expect(oldSnapshot.completedRuns[0]?.sessionId).toBe('session-1');
      expect(oldSnapshot.completedRuns[0]?.resultPreview).toBe('old result');
    });

    it('切换 root 后迟到的旧 run 事件只更新旧快照，不污染当前 run', () => {
      const store = useSwarmStore.getState();

      store.handleEvent(evt('swarm:started', {}, 1000, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:agent:added', {
        agentState: agent('a1', { status: 'running', startTime: 1000 }),
      }, 1010, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:started', {}, 2000, 'session-2', 'run-2'));

      store.handleEvent(evt('swarm:agent:completed', {
        agentState: agent('a1', {
          status: 'completed',
          startTime: 1000,
          endTime: 1200,
          resultPreview: 'late old result',
        }),
      }, 2100, 'session-1', 'run-1'));

      const state = useSwarmStore.getState();
      const oldSnapshot = state.runSnapshots['session-1::run-1'];

      expect(state.activeSessionId).toBe('session-2');
      expect(state.activeRunId).toBe('run-2');
      expect(state.completedRuns).toHaveLength(0);
      expect(state.agents).toHaveLength(0);
      expect(oldSnapshot.agents[0]?.status).toBe('completed');
      expect(oldSnapshot.completedRuns[0]?.resultPreview).toBe('late old result');
      expect(oldSnapshot.eventLog.some((entry) => entry.type === 'swarm:agent:completed')).toBe(true);
    });

    it('迟到的旧 run cancel 终态也保留 cancelled result 语义', () => {
      const store = useSwarmStore.getState();

      store.handleEvent(evt('swarm:started', {}, 1000, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:agent:added', {
        agentState: agent('a1', { status: 'running', startTime: 1000 }),
      }, 1010, 'session-1', 'run-1'));
      store.handleEvent(evt('swarm:started', {}, 2000, 'session-2', 'run-2'));

      store.handleEvent(evt('swarm:agent:failed', {
        agentState: agent('a1', {
          status: 'cancelled',
          startTime: 1000,
          endTime: 1200,
          error: 'Cancelled by user',
        }),
      }, 2100, 'session-1', 'run-1'));

      const state = useSwarmStore.getState();
      const oldSnapshot = state.runSnapshots['session-1::run-1'];

      expect(state.completedRuns).toHaveLength(0);
      expect(oldSnapshot.agents[0]?.status).toBe('cancelled');
      expect(oldSnapshot.completedRuns[0]?.status).toBe('cancelled');
    });
  });

  describe('completion events', () => {
    it('swarm:completed 置 isRunning=false 并写 aggregation', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1', { status: 'completed' }) }));
      store.handleEvent(
        evt('swarm:completed', {
          result: {
            success: true,
            totalTime: 1000,
            aggregation: {
              summary: '搞定',
              filesChanged: ['a.ts'],
              totalCost: 0.1,
              totalDuration: 1000,
              speedup: 1.5,
              successRate: 1,
              totalIterations: 5,
            },
          },
        }),
      );

      const state = useSwarmStore.getState();
      expect(state.isRunning).toBe(false);
      expect(state.aggregation?.summary).toBe('搞定');
      expect(state.executionPhase).toBe('completed');
    });

    it('swarm:cancelled 将 phase 推向 cancelled（基于已 cancelled agent）', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1', { status: 'cancelled' }) }));
      store.handleEvent(evt('swarm:cancelled', {}));

      expect(useSwarmStore.getState().executionPhase).toBe('cancelled');
    });
  });

  describe('reset', () => {
    it('reset 清空所有字段', () => {
      const store = useSwarmStore.getState();
      store.handleEvent(evt('swarm:started', {}));
      store.handleEvent(evt('swarm:agent:added', { agentState: agent('a1') }));
      store.reset();

      const state = useSwarmStore.getState();
      expect(state.isRunning).toBe(false);
      expect(state.agents).toHaveLength(0);
      expect(state.executionPhase).toBe('idle');
      expect(state.eventLog).toHaveLength(0);
      expect(Object.keys(state.runSnapshots)).toHaveLength(0);
    });
  });
});
