import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarMessageHitList } from '../../../src/renderer/components/features/sidebar/SidebarMessageHitList';

describe('SidebarMessageHitList', () => {
  it('renders additional message hits without repeating the best hit', () => {
    const html = renderToStaticMarkup(
      <SidebarMessageHitList
        sessionId="session-1"
        onSelectHit={vi.fn()}
        hits={[
          {
            sessionId: 'session-1',
            messageId: 'best',
            snippet: 'best match',
            messagePositionLabel: '消息 1',
            role: 'user',
            timestamp: 1,
            matchCount: 1,
            relevance: 0.9,
          },
          {
            sessionId: 'session-1',
            messageId: 'assistant-hit',
            snippet: 'assistant extra match',
            messagePositionLabel: '消息 2',
            role: 'assistant',
            timestamp: Date.now() - 5 * 60 * 1000,
            matchCount: 2,
            relevance: 0.8,
          },
          {
            sessionId: 'session-1',
            messageId: 'system-hit',
            snippet: 'system extra match',
            messagePositionLabel: '消息 3',
            role: 'system',
            timestamp: Date.now() - 2 * 60 * 60 * 1000,
            matchCount: 1,
            relevance: 0.7,
          },
        ]}
      />,
    );

    expect(html).not.toContain('best match');
    expect(html).toContain('助手');
    expect(html).toContain('消息 2');
    expect(html).toContain('分钟前');
    expect(html).toContain('assistant extra match');
    expect(html).toContain('2x');
    expect(html).toContain('系统');
    expect(html).toContain('消息 3');
    expect(html).toContain('小时前');
    expect(html).toContain('system extra match');
  });

  it('renders nothing when there is only one hit', () => {
    const html = renderToStaticMarkup(
      <SidebarMessageHitList
        sessionId="session-1"
        onSelectHit={vi.fn()}
        hits={[
          {
            sessionId: 'session-1',
            messageId: 'best',
            snippet: 'best match',
            messagePositionLabel: '消息 1',
            role: 'user',
            timestamp: 1,
            matchCount: 1,
            relevance: 0.9,
          },
        ]}
      />,
    );

    expect(html).toBe('');
  });
});
