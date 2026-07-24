import { describe, expect, it } from 'vitest';
import {
  buildSidebarMessageSearchHitGroups,
  buildSidebarMessageSearchHitMap,
  formatSidebarMessageSearchHitLabel,
  formatSidebarMessageSearchHitMeta,
  getCurrentProjectSearchSessionIds,
  resolveSidebarSearchScope,
  stripSearchHighlightMarkers,
} from '../../../src/renderer/utils/sidebarMessageSearch';

describe('sidebarMessageSearch', () => {
  it('strips markdown highlight markers from snippets', () => {
    expect(stripSearchHighlightMarkers('...hello **project**\n  session...')).toBe('...hello project session...');
  });

  it('keeps the best message hit per session and filters unknown sessions', () => {
    const hits = buildSidebarMessageSearchHitMap([
      {
        sessionId: 'session-1',
        sessionTitle: 'One',
        messageId: 'message-old',
        messageIndex: 0,
        role: 'assistant',
        timestamp: 100,
        matchOffset: 4,
        relevance: 0.4,
        snippet: 'old **match**',
        matchCount: 1,
      },
      {
        sessionId: 'session-1',
        sessionTitle: 'One',
        messageId: 'message-best',
        messageIndex: 1,
        turnNumber: 2,
        role: 'user',
        timestamp: 90,
        matchOffset: 7,
        relevance: 0.8,
        snippet: 'better **match**',
        matchCount: 2,
      },
      {
        sessionId: 'session-2',
        sessionTitle: 'Two',
        role: 'assistant',
        timestamp: 120,
        relevance: 0.7,
        snippet: 'filtered out',
        matchCount: 1,
      },
    ], new Set(['session-1']));

    expect(Object.keys(hits)).toEqual(['session-1']);
    expect(hits['session-1']).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-best',
      messageIndex: 1,
      turnNumber: 2,
      role: 'user',
      snippet: 'better match',
      messagePositionLabel: '第 2 轮',
      matchOffset: 7,
      matchCount: 2,
      relevance: 0.8,
    });
    expect(formatSidebarMessageSearchHitLabel(hits['session-1'])).toBe('消息命中 · better match');
    expect(formatSidebarMessageSearchHitMeta(hits['session-1'], 90 + 5 * 60 * 1000)).toBe('第 2 轮 · 5分钟前');
  });

  it('groups multiple message hits per session by relevance and limits extra context', () => {
    const groups = buildSidebarMessageSearchHitGroups([
      {
        sessionId: 'session-1',
        sessionTitle: 'One',
        messageId: 'message-low',
        messageIndex: 0,
        role: 'assistant',
        timestamp: 200,
        matchOffset: 2,
        relevance: 0.4,
        snippet: 'low **match**',
        matchCount: 1,
      },
      {
        sessionId: 'session-1',
        sessionTitle: 'One',
        messageId: 'message-best',
        messageIndex: 1,
        role: 'user',
        timestamp: 100,
        matchOffset: 7,
        relevance: 0.9,
        snippet: 'best **match**',
        matchCount: 3,
      },
      {
        sessionId: 'session-1',
        sessionTitle: 'One',
        messageId: 'message-recent',
        messageIndex: 2,
        role: 'assistant',
        timestamp: 300,
        matchOffset: 4,
        relevance: 0.6,
        snippet: 'recent **match**',
        matchCount: 1,
      },
      {
        sessionId: 'session-1',
        sessionTitle: 'One',
        messageId: 'message-over-limit',
        messageIndex: 3,
        role: 'assistant',
        timestamp: 400,
        matchOffset: 4,
        relevance: 0.1,
        snippet: 'over limit',
        matchCount: 1,
      },
      {
        sessionId: 'session-2',
        sessionTitle: 'Two',
        messageId: 'message-filtered',
        messageIndex: 0,
        role: 'system',
        timestamp: 400,
        relevance: 1,
        snippet: 'filtered **match**',
        matchCount: 1,
      },
    ], new Set(['session-1']), 3);

    expect(Object.keys(groups)).toEqual(['session-1']);
    expect(groups['session-1'].bestHit.messageId).toBe('message-best');
    expect(groups['session-1'].hits.map((hit) => hit.messageId)).toEqual([
      'message-best',
      'message-recent',
      'message-low',
    ]);
    expect(groups['session-1'].hits[0].snippet).toBe('best match');
    expect(groups['session-1'].hits[1].messagePositionLabel).toBe('消息 3');
    expect(groups['session-1'].totalHitCount).toBe(4);
  });

  it('resolves the current project search session ids by project id first', () => {
    const ids = getCurrentProjectSearchSessionIds([
      { id: 'current', projectId: 'proj-1', workingDirectory: '/repo/current' },
      { id: 'same-project', projectId: 'proj-1', workingDirectory: '/repo/other' },
      { id: 'same-workspace-only', workingDirectory: '/repo/current' },
      { id: 'other', projectId: 'proj-2', workingDirectory: '/repo/current' },
    ], 'current');

    expect(Array.from(ids).sort()).toEqual(['current', 'same-project']);
  });

  it('falls back to workspace when the current session has no project id', () => {
    const ids = getCurrentProjectSearchSessionIds([
      { id: 'current', workingDirectory: '/repo/code-agent' },
      { id: 'same-workspace', workingDirectory: '/repo/code-agent' },
      { id: 'other', workingDirectory: '/repo/archive' },
    ], 'current');

    expect(Array.from(ids).sort()).toEqual(['current', 'same-workspace']);
  });

  it('falls back to all scope when there is no current project scope', () => {
    expect(resolveSidebarSearchScope('current-project', new Set())).toBe('all');
    expect(resolveSidebarSearchScope('current-project', new Set(['session-1']))).toBe('current-project');
    expect(resolveSidebarSearchScope('all', new Set(['session-1']))).toBe('all');
  });
});
