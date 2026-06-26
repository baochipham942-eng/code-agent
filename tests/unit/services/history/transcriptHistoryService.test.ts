import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import { TranscriptHistoryService } from '../../../../src/host/services/history/transcriptHistoryService';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'msg-default',
    role: 'assistant',
    content: '',
    timestamp: 1778664000000,
    ...overrides,
  } as Message;
}

describe('TranscriptHistoryService', () => {
  it('uses the existing transcript FTS search and around APIs', async () => {
    const searchTranscriptFts = vi.fn(() => [
      {
        messageId: 'msg-1',
        sessionId: 'sess-1',
        kind: 'user_text',
        toolName: null,
        snippet: '爸明确说轨迹库为权威',
        timestamp: 1778664000000,
      },
    ]);
    const getTranscriptAround = vi.fn(() => ({
      sessionId: 'sess-1',
      messages: [
        { message: message({ id: 'msg-1', role: 'user', content: '轨迹库为权威，memory 是缓存' }), matched: true },
      ],
    }));

    const service = new TranscriptHistoryService({
      searchTranscriptFts,
      getTranscriptAround,
    });

    const hits = await service.search('轨迹库 权威', {
      sessionId: 'sess-1',
      kinds: ['user_text'],
      limit: 3,
    });
    const around = await service.around('msg-1', { before: 2, after: 2 });

    expect(searchTranscriptFts).toHaveBeenCalledWith('轨迹库 权威', {
      sessionId: 'sess-1',
      kinds: ['user_text'],
      limit: 3,
    });
    expect(getTranscriptAround).toHaveBeenCalledWith('msg-1', { before: 2, after: 2 });
    expect(hits).toHaveLength(1);
    expect(around?.messages[0]?.message.content).toContain('memory 是缓存');
  });

  it('does not create a second SQLite query path for short or empty queries', async () => {
    const searchTranscriptFts = vi.fn();
    const service = new TranscriptHistoryService({
      searchTranscriptFts,
      getTranscriptAround: vi.fn(),
    });

    await expect(service.search('ab')).resolves.toEqual([]);
    await expect(service.search('   ')).resolves.toEqual([]);
    expect(searchTranscriptFts).not.toHaveBeenCalled();
  });
});
