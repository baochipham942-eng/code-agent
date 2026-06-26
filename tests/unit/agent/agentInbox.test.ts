// ============================================================================
// Agent Inbox 桥接统一查询入口（swarm 护栏 P1-2 #4）
// ============================================================================
//
// 三套消息源（SpawnGuard.messageQueue / Coordinator.messageQueues / TeammateService.inbox）
// 割裂，子代理拿不到完整待办视图。桥接方案：统一只读门面聚合三源，保留各源原有
// 写入与 drain 不动（合并风险更高，故选桥接）。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  peekUnifiedInbox,
  type InboxSources,
} from '../../../src/host/agent/agentInbox';
import {
  getSpawnGuard,
  resetSpawnGuard,
  createTextMessage,
  type AgentMessage,
} from '../../../src/host/agent/spawnGuard';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutor';
import type { TeammateMessage } from '../../../src/host/agent/teammate/types';

describe('peekUnifiedInbox 桥接聚合', () => {
  const agentMsg = (from: string, payload: string, ts: number): AgentMessage => ({
    type: 'text', from, payload, timestamp: ts,
  });
  const teammateMsg = (from: string, content: string, ts: number): TeammateMessage => ({
    id: `m-${ts}`, from, to: 'agent-1', type: 'coordination', content, timestamp: ts,
  });

  it('聚合三源并按时间戳排序', () => {
    const sources: InboxSources = {
      spawnGuard: { peekMessages: () => [agentMsg('parent', 'sg', 300)] },
      coordinator: { peekMessages: () => [agentMsg('user', 'co', 100)] },
      teammateService: { getInbox: () => [teammateMsg('peer', 'tm', 200)] },
    };
    const merged = peekUnifiedInbox('agent-1', sources);
    expect(merged.map(m => m.source)).toEqual(['coordinator', 'teammate', 'spawn-guard']);
    expect(merged.map(m => m.payload)).toEqual(['co', 'tm', 'sg']);
  });

  it('teammate 消息归一化：content → payload，标记 source=teammate', () => {
    const sources: InboxSources = {
      teammateService: { getInbox: () => [teammateMsg('peer', 'hello', 50)] },
    };
    const merged = peekUnifiedInbox('agent-1', sources);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ source: 'teammate', from: 'peer', payload: 'hello', type: 'coordination' });
  });

  it('缺失的源被跳过，不报错', () => {
    const merged = peekUnifiedInbox('agent-1', {
      spawnGuard: { peekMessages: () => [agentMsg('p', 'only', 10)] },
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('spawn-guard');
  });
});

describe('SpawnGuard.peekMessages 非破坏性读', () => {
  beforeEach(() => resetSpawnGuard());
  afterEach(() => resetSpawnGuard());

  it('peek 返回队列副本，不消费消息（后续 drain 仍能取到）', () => {
    const guard = getSpawnGuard();
    const pending = new Promise<SubagentResult>(() => {});
    guard.register('a1', 'coder', 't', pending, new AbortController());
    guard.sendMessage('a1', createTextMessage('parent', 'hi'));

    const peeked = guard.peekMessages('a1');
    expect(peeked).toHaveLength(1);
    expect(peeked[0].payload).toBe('hi');

    // 非破坏：drain 仍应取到同一条
    const drained = guard.drainMessages('a1');
    expect(drained).toHaveLength(1);
    expect(drained[0].payload).toBe('hi');
  });

  it('未知 agent peek 返回空数组', () => {
    expect(getSpawnGuard().peekMessages('nope')).toEqual([]);
  });
});
