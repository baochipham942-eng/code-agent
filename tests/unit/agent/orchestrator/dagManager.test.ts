import { describe, it, expect } from 'vitest';
import {
  mapAgentEventToDAGStatus,
  mapAutoAgentStatusToDAGStatus,
  buildDAGStatusEvent,
} from '../../../../src/main/agent/orchestrator/dagManager';
import type { AgentEvent } from '../../../../src/shared/contract';
import type { TaskStatusEventData } from '../../../../src/shared/contract/dagVisualization';

describe('dagManager', () => {
  describe('mapAgentEventToDAGStatus', () => {
    it('turn_start → main 任务 running + startedAt', () => {
      const r = mapAgentEventToDAGStatus({ type: 'turn_start' } as AgentEvent);
      expect(r).toMatchObject({ type: 'task:status', taskId: 'main', status: 'running' });
      expect(r?.startedAt).toEqual(expect.any(Number));
    });

    it('agent_complete → completed + completedAt', () => {
      const r = mapAgentEventToDAGStatus({ type: 'agent_complete' } as AgentEvent);
      expect(r).toMatchObject({ taskId: 'main', status: 'completed' });
      expect(r?.completedAt).toEqual(expect.any(Number));
    });

    it('agent_cancelled → cancelled + completedAt', () => {
      const r = mapAgentEventToDAGStatus({ type: 'agent_cancelled' } as AgentEvent);
      expect(r).toMatchObject({ taskId: 'main', status: 'cancelled' });
      expect(r?.completedAt).toEqual(expect.any(Number));
    });

    it('error → failed + completedAt', () => {
      const r = mapAgentEventToDAGStatus({ type: 'error' } as AgentEvent);
      expect(r).toMatchObject({ taskId: 'main', status: 'failed' });
      expect(r?.completedAt).toEqual(expect.any(Number));
    });

    it('未映射的事件类型 → null', () => {
      const r = mapAgentEventToDAGStatus({ type: 'tool_call' } as unknown as AgentEvent);
      expect(r).toBeNull();
    });
  });

  describe('mapAutoAgentStatusToDAGStatus', () => {
    it.each([
      ['pending', 'pending'],
      ['queued', 'pending'],
      ['running', 'running'],
      ['executing', 'running'],
      ['completed', 'completed'],
      ['done', 'completed'],
      ['success', 'completed'],
      ['failed', 'failed'],
      ['error', 'failed'],
      ['cancelled', 'cancelled'],
      ['stopped', 'cancelled'],
      ['skipped', 'skipped'],
    ])('原始状态 %s → DAG 状态 %s', (input, expected) => {
      const r = mapAutoAgentStatusToDAGStatus('agent-1', input);
      expect(r).toMatchObject({ type: 'task:status', taskId: 'agent-1', status: expected });
    });

    it('未知状态兜底为 running', () => {
      const r = mapAutoAgentStatusToDAGStatus('agent-x', 'whoknows');
      expect(r.status).toBe('running');
      expect(r.startedAt).toEqual(expect.any(Number));
    });

    it('running 仅带 startedAt，不带 completedAt', () => {
      const r = mapAutoAgentStatusToDAGStatus('a', 'running');
      expect(r.startedAt).toEqual(expect.any(Number));
      expect(r.completedAt).toBeUndefined();
    });

    it('completed 仅带 completedAt，不带 startedAt', () => {
      const r = mapAutoAgentStatusToDAGStatus('a', 'completed');
      expect(r.completedAt).toEqual(expect.any(Number));
      expect(r.startedAt).toBeUndefined();
    });

    it('failed 带 completedAt', () => {
      const r = mapAutoAgentStatusToDAGStatus('a', 'failed');
      expect(r.completedAt).toEqual(expect.any(Number));
    });

    it('cancelled 不带任何时间戳', () => {
      const r = mapAutoAgentStatusToDAGStatus('a', 'cancelled');
      expect(r.startedAt).toBeUndefined();
      expect(r.completedAt).toBeUndefined();
    });
  });

  describe('buildDAGStatusEvent', () => {
    it('将 statusUpdate 包装为带 dagId/timestamp 的可视化事件', () => {
      const statusUpdate: TaskStatusEventData = {
        type: 'task:status',
        taskId: 'main',
        status: 'running',
      };
      const ev = buildDAGStatusEvent('dag-1', statusUpdate);
      expect(ev).toMatchObject({ type: 'task:status', dagId: 'dag-1', data: statusUpdate });
      expect(ev.timestamp).toEqual(expect.any(Number));
    });
  });
});
