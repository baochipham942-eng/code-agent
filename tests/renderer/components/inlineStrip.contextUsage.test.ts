 
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const inlineStripMocks = vi.hoisted(() => ({
  compactionState: {
    status: 'idle',
    result: null as any,
    error: null as string | null,
  },
  invoke: vi.fn(),
  refreshContextHealth: vi.fn(),
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

vi.mock('../../../src/renderer/stores/contextCompactionStore', () => ({
  useContextCompactionStore: (selector: (state: typeof inlineStripMocks.compactionState) => unknown) => (
    selector(inlineStripMocks.compactionState)
  ),
}));

import { InlineStrip } from '../../../src/renderer/components/features/chat/InlineStrip';

describe('InlineStrip context usage rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inlineStripMocks.compactionState = {
      status: 'idle',
      result: null,
      error: null,
    };
  });

  it('only renders while compaction feedback is active', () => {
    expect(renderToStaticMarkup(React.createElement(InlineStrip))).toBe('');

    inlineStripMocks.compactionState = {
      status: 'active',
      result: null,
      error: null,
    };
    const html = renderToStaticMarkup(React.createElement(InlineStrip));

    expect(html).toContain('正在压缩上下文');
    expect(html).not.toContain('Compact');
  });

  it('renders compact success feedback without showing context usage numbers', () => {
    inlineStripMocks.compactionState = {
      status: 'success',
      result: {
        success: true,
        compressionCount: 1,
        totalSavedTokens: 24000,
      },
      error: null,
    };

    const html = renderToStaticMarkup(React.createElement(InlineStrip));

    expect(html).toContain('已释放 24k');
    expect(html).not.toContain('%');
  });
});
