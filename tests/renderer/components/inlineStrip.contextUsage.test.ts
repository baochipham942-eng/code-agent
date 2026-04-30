/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const inlineStripMocks = vi.hoisted(() => ({
  model: null as any,
  invoke: vi.fn(),
  refreshContextHealth: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useStatusRailModel', () => ({
  useStatusRailModel: () => inlineStripMocks.model,
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      currentSessionId: 'session-1',
      refreshContextHealth: inlineStripMocks.refreshContextHealth,
    }),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: inlineStripMocks.invoke,
  },
}));

import { InlineStrip } from '../../../src/renderer/components/features/chat/InlineStrip';

function makeStatusRailModel(usagePercent: number) {
  const warningLevel = usagePercent >= 85
    ? 'critical'
    : usagePercent >= 70
      ? 'warning'
      : 'normal';

  return {
    context: {
      currentTokens: usagePercent * 1000,
      maxTokens: 100000,
      usagePercent,
      warningLevel,
      buckets: { system: 0, user: 0, assistant: 0, tool: 0 },
      items: [],
    },
    compact: {
      canCompact: usagePercent >= 70,
      compressionCount: 0,
      totalSavedTokens: 0,
    },
    todos: { items: [], completed: 0, total: 0 },
    outputs: { files: [], count: 0 },
    swarm: { isRunning: false, agentCount: 0, selectedAgentId: null },
    cache: { promptCacheHits: 0, promptCacheMisses: 0, totalCachedTokens: 0, hitRate: 0 },
  };
}

describe('InlineStrip context usage rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inlineStripMocks.model = makeStatusRailModel(0);
  });

  it('renders both low-usage and high-usage states without throwing', () => {
    inlineStripMocks.model = makeStatusRailModel(45);
    expect(renderToStaticMarkup(React.createElement(InlineStrip))).toBe('');

    inlineStripMocks.model = makeStatusRailModel(82);
    const html = renderToStaticMarkup(React.createElement(InlineStrip));

    expect(html).toContain('82%');
    expect(html).toContain('Compact');
  });
});
