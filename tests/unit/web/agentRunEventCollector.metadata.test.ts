// AgentRunEventCollector metadata 采集回归测试。
// 背景：web 路径三处 assistant 落库（cache push / sm.addMessageToSession / db.addMessage）
// 都从 collector 重建消息对象，collector 不采集 message 事件的 metadata →
// turnQuality（安静徽标）在 loop 未自行落库的兜底场景下整体丢失。

import { describe, expect, it } from 'vitest';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import { AgentRunEventCollector } from '../../../src/web/routes/agentRunEventCollector';

function makeCollector(): AgentRunEventCollector {
  return new AgentRunEventCollector({
    sessionId: 'sess-1',
    emitToolWarning: () => undefined,
  });
}

function assistantMessageEvent(metadata?: Message['metadata'], id = 'm-1'): AgentEvent {
  return {
    type: 'message',
    data: {
      id,
      role: 'assistant',
      content: '最终回复',
      timestamp: 100,
      ...(metadata ? { metadata } : {}),
    },
  } as AgentEvent;
}

const turnQualityMetadata = {
  turnQuality: {
    capabilities: {
      agentId: 'explore',
      agentName: 'Explorer',
      requestedAgentId: 'explore',
    },
  },
} as Message['metadata'];

describe('AgentRunEventCollector assistantMetadata', () => {
  it('采集 assistant message 事件携带的 metadata', () => {
    const collector = makeCollector();
    collector.observe(assistantMessageEvent(turnQualityMetadata), true);
    expect(collector.assistantMetadata).toEqual(turnQualityMetadata);
  });

  it('后到的无 metadata assistant 消息不清空已采集值', () => {
    const collector = makeCollector();
    collector.observe(assistantMessageEvent(turnQualityMetadata, 'm-1'), true);
    collector.observe(assistantMessageEvent(undefined, 'm-2'), true);
    expect(collector.assistantMetadata).toEqual(turnQualityMetadata);
  });

  it('后到的带 metadata assistant 消息覆盖为最新值', () => {
    const later = {
      turnQuality: {
        capabilities: { agentId: 'default', agentName: 'default', requestedAgentId: '__ghost__' },
      },
    } as Message['metadata'];
    const collector = makeCollector();
    collector.observe(assistantMessageEvent(turnQualityMetadata, 'm-1'), true);
    collector.observe(assistantMessageEvent(later, 'm-2'), true);
    expect(collector.assistantMetadata).toEqual(later);
  });

  it('未透出（emitted=false）的事件不采集', () => {
    const collector = makeCollector();
    collector.observe(assistantMessageEvent(turnQualityMetadata), false);
    expect(collector.assistantMetadata).toBeUndefined();
  });

  it('非 assistant 角色的 message 事件不采集', () => {
    const collector = makeCollector();
    collector.observe({
      type: 'message',
      data: {
        id: 'u-1',
        role: 'user',
        content: 'hi',
        timestamp: 100,
        metadata: turnQualityMetadata,
      },
    } as AgentEvent, true);
    expect(collector.assistantMetadata).toBeUndefined();
  });
});
