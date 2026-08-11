// ============================================================================
// orchestratorDagSync.initRunDag — run 主线 DAG 初始化（F-4c 抽出，补测钉住行为）
// ----------------------------------------------------------------------------
// TaskDAG / sendDAGInitEvent / dagManager 全 mock：验 dagId 拼法、DAG 建节点、
// 初始化事件下发，以及 dagAwareOnEvent「透传 onEvent + 映射进 DAG 状态广播」双职责。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';

const addAgentTask = vi.fn();
const TaskDAGCtor = vi.fn();
const sendDAGInitEvent = vi.fn();
const mapAgentEventToDAGStatus = vi.fn();
const buildDAGStatusEvent = vi.fn();

vi.mock('../../../src/host/scheduler/TaskDAG', () => ({
  TaskDAG: class {
    constructor(...args: unknown[]) {
      TaskDAGCtor(...args);
    }
    addAgentTask(...args: unknown[]) {
      addAgentTask(...args);
    }
  },
}));
vi.mock('../../../src/host/scheduler/dagEventBridge', () => ({
  sendDAGInitEvent: (...args: unknown[]) => sendDAGInitEvent(...args),
}));
vi.mock('../../../src/host/agent/orchestrator/dagManager', () => ({
  mapAgentEventToDAGStatus: (...args: unknown[]) => mapAgentEventToDAGStatus(...args),
  buildDAGStatusEvent: (...args: unknown[]) => buildDAGStatusEvent(...args),
  mapAutoAgentStatusToDAGStatus: vi.fn(),
}));

import { initRunDag } from '../../../src/host/agent/orchestratorDagSync';

const evt: AgentEvent = { type: 'error', data: { message: 'boom' } };

describe('initRunDag', () => {
  afterEach(() => vi.clearAllMocks());

  it('dagId 用 sessionId；建单 main 节点并发初始化事件', () => {
    initRunDag({ sessionId: 'sess-1', content: '帮我实现登录', onEvent: vi.fn() });

    expect(TaskDAGCtor).toHaveBeenCalledWith('conv-sess-1', '帮我实现登录');
    expect(addAgentTask).toHaveBeenCalledTimes(1);
    expect(sendDAGInitEvent).toHaveBeenCalledTimes(1);
  });

  it('长 content：DAG 标题截 50 + 省略号，节点描述截 100', () => {
    const long = 'x'.repeat(120);
    initRunDag({ sessionId: 's', content: long, onEvent: vi.fn() });

    expect(TaskDAGCtor).toHaveBeenCalledWith('conv-s', 'x'.repeat(50) + '...');
    const meta = addAgentTask.mock.calls[0][2] as { description: string };
    expect(meta.description).toBe('x'.repeat(100));
  });

  it('dagAwareOnEvent 先透传 onEvent；状态映射命中时广播 DAG 事件', () => {
    mapAgentEventToDAGStatus.mockReturnValue({ some: 'status' });
    buildDAGStatusEvent.mockReturnValue({ viz: 'event' });
    const onEvent = vi.fn();
    const broadcastDAGEvent = vi.fn();

    const { dagAwareOnEvent } = initRunDag({ sessionId: 's', content: 'c', onEvent, broadcastDAGEvent });
    dagAwareOnEvent(evt);

    expect(onEvent).toHaveBeenCalledWith(evt);
    expect(buildDAGStatusEvent).toHaveBeenCalledWith('conv-s', { some: 'status' });
    expect(broadcastDAGEvent).toHaveBeenCalledWith({ viz: 'event' });
  });

  it('状态映射未命中（null）时只透传，不广播', () => {
    mapAgentEventToDAGStatus.mockReturnValue(null);
    const onEvent = vi.fn();
    const broadcastDAGEvent = vi.fn();

    const { dagAwareOnEvent } = initRunDag({ sessionId: 's', content: 'c', onEvent, broadcastDAGEvent });
    dagAwareOnEvent(evt);

    expect(onEvent).toHaveBeenCalledWith(evt);
    expect(broadcastDAGEvent).not.toHaveBeenCalled();
  });
});
