import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  getPersistenceHealth,
  seedSessionMessagesFromPersisted,
  sessionMessages,
  setDbAvailable,
  toCachedSessionMessages,
} from '../../../src/web/helpers/sessionCache';

afterEach(() => {
  setDbAvailable(false, new Error('test reset'));
  sessionMessages.clear();
});

describe('web session persistence health', () => {
  it('reports durable database persistence when DB is available', () => {
    setDbAvailable(true);

    expect(getPersistenceHealth()).toMatchObject({
      status: 'available',
      mode: 'database',
      durable: true,
      message: '历史会持久化到本机数据库。',
    });
  });

  it('reports memory-only fallback with the init failure reason', () => {
    setDbAvailable(false, new Error('native binding missing'));

    expect(getPersistenceHealth()).toMatchObject({
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      message: '历史持久化不可用，当前只会话内有效。',
      reason: 'native binding missing',
    });
  });
});

describe('toCachedSessionMessages metadata 保留', () => {
  it('assistant 消息的 metadata（turnQuality）经缓存水合不丢失', () => {
    const metadata = {
      turnQuality: {
        capabilities: { agentId: 'explore', agentName: 'Explorer', requestedAgentId: 'explore' },
      },
    } as Message['metadata'];
    const cached = toCachedSessionMessages([
      {
        id: 'm-1',
        role: 'assistant',
        content: '回复',
        timestamp: 100,
        metadata,
      } as Message,
    ]);
    expect(cached[0]?.metadata).toEqual(metadata);
  });

  // 工单行为不变清单 #5：持久化消息转缓存时所有富字段原样保留。
  it('preserves thinking, contentParts, artifacts, attachments and metadata together', () => {
    const richMessage = {
      id: 'm-rich',
      role: 'assistant',
      content: '富字段回复',
      timestamp: 200,
      thinking: '思考过程',
      contentParts: [
        { type: 'text', text: '富字段' },
        { type: 'tool_call', toolCallId: 'tool-rich' },
      ],
      artifacts: [{
        id: 'artifact-rich',
        type: 'chart',
        content: '{"title":"Rich"}',
        title: 'Rich',
        version: 1,
      }],
      attachments: [{
        id: 'attachment-rich',
        type: 'file',
        category: 'text',
        name: 'rich.txt',
        size: 4,
        mimeType: 'text/plain',
        data: 'rich',
      }],
      metadata: {
        turnQuality: {
          capabilities: { agentId: 'explore', agentName: 'Explorer' },
        },
      },
    } as Message;

    expect(toCachedSessionMessages([richMessage])).toEqual([{
      id: 'm-rich',
      role: 'assistant',
      content: '富字段回复',
      timestamp: 200,
      toolCalls: undefined,
      thinking: '思考过程',
      contentParts: richMessage.contentParts,
      artifacts: richMessage.artifacts,
      attachments: richMessage.attachments,
      metadata: richMessage.metadata,
    }]);
  });
});

describe('sessionMessages LRU characterization', () => {
  // 工单行为不变清单 #7：缓存最多 50 个会话，按插入顺序逐出最旧 key。
  it('evicts the oldest session after persisted hydration exceeds 50 entries', () => {
    for (let index = 0; index < 51; index += 1) {
      seedSessionMessagesFromPersisted(`session-${index}`, [{
        id: `message-${index}`,
        role: 'user',
        content: `message-${index}`,
        timestamp: index,
      } as Message]);
    }

    expect(sessionMessages.size).toBe(50);
    expect(sessionMessages.has('session-0')).toBe(false);
    expect(sessionMessages.get('session-1')?.[0]?.id).toBe('message-1');
    expect(sessionMessages.get('session-50')?.[0]?.id).toBe('message-50');
  });
});
