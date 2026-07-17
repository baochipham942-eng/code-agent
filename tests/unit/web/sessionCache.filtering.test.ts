// ============================================================================
// sessionCache.toCachedSessionMessages：过滤非 user/assistant、剥 inline attachment 块。
// sessionCache.persistence.test.ts 只测 health + 富字段保留。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { toCachedSessionMessages } from '../../../src/web/helpers/sessionCache';

describe('toCachedSessionMessages filtering', () => {
  it('drops tool-role messages from the cache projection', () => {
    const cached = toCachedSessionMessages([
      {
        id: 'u1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
      } as Message,
      {
        id: 't1',
        role: 'tool',
        content: 'tool output',
        timestamp: 2,
      } as Message,
      {
        id: 'a1',
        role: 'assistant',
        content: 'hello',
        timestamp: 3,
      } as Message,
    ]);

    expect(cached.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(cached.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
  });

  it('maps empty input to empty array', () => {
    expect(toCachedSessionMessages([])).toEqual([]);
  });

  it('strips inline <attachment category=...> blocks from content while keeping attachments field', () => {
    const cached = toCachedSessionMessages([
      {
        id: 'u-attach',
        role: 'user',
        content: 'see this\n\n<attachment category="text" name="a.txt">payload</attachment>\n',
        timestamp: 10,
        attachments: [{
          id: 'file-1',
          type: 'file',
          category: 'text',
          name: 'a.txt',
          mimeType: 'text/plain',
          size: 3,
        }],
      } as Message,
    ]);

    expect(cached).toHaveLength(1);
    expect(cached[0].content).toBe('see this');
    expect(cached[0].content).not.toMatch(/<attachment\b/i);
    expect(cached[0].attachments).toEqual([
      expect.objectContaining({ id: 'file-1', name: 'a.txt' }),
    ]);
  });

  it('prefers thinking over reasoning when both exist', () => {
    const cached = toCachedSessionMessages([
      {
        id: 'a-think',
        role: 'assistant',
        content: 'answer',
        timestamp: 1,
        thinking: 'explicit thinking',
        reasoning: 'legacy reasoning',
      } as Message,
    ]);
    expect(cached[0].thinking).toBe('explicit thinking');
  });

  it('falls back to reasoning when thinking is absent', () => {
    const cached = toCachedSessionMessages([
      {
        id: 'a-reason',
        role: 'assistant',
        content: 'answer',
        timestamp: 1,
        reasoning: 'only reasoning',
      } as Message,
    ]);
    expect(cached[0].thinking).toBe('only reasoning');
  });
});
