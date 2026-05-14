import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pillMocks = vi.hoisted(() => ({
  appState: {
    contextHealth: {
      usagePercent: 82,
      currentTokens: 82000,
      maxTokens: 100000,
      warningLevel: 'warning',
    },
  },
  invoke: vi.fn(),
  refreshContextHealth: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof pillMocks.appState) => unknown) => (
    selector ? selector(pillMocks.appState) : pillMocks.appState
  ),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      currentSessionId: 'session-1',
      refreshContextHealth: pillMocks.refreshContextHealth,
    }),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: pillMocks.invoke,
  },
}));

import { ContextUsagePill } from '../../../src/renderer/components/features/chat/ContextUsagePill';
import { useContextCompactionStore } from '../../../src/renderer/stores/contextCompactionStore';

describe('ContextUsagePill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useContextCompactionStore.setState({
      status: 'idle',
      result: null,
      error: null,
      updatedAt: 0,
    });
  });

  it('renders as an icon-only persistent context control', () => {
    const html = renderToStaticMarkup(React.createElement(ContextUsagePill));

    expect(html).toContain('aria-label="上下文使用"');
    expect(html).toContain('82% 已用 · 82k/100k 标记');
    expect(html).not.toContain('<span>82%</span>');
    expect(html).not.toContain('Context window');
  });
});
