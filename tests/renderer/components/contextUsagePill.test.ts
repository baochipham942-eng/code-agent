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
    // useI18n() 无 selector 整取 store，这几个字段得在。
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
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

  // 原来这里钉的是「只有图标」。产品负责人拍板推翻：一个没有刻度的圆环读不出用了多少，
  // 百分比只在 hover title 和展开面板里等于没有。折叠态必须有可读锚点。
  it('折叠态给出可读的百分比锚点，不是一个光秃秃的环', () => {
    const html = renderToStaticMarkup(React.createElement(ContextUsagePill));

    expect(html).toContain('aria-label="上下文使用"');
    expect(html).toContain('82% 已用 · 82k/100k 标记');
    expect(html).toContain('data-testid="context-usage-percent"');
    expect(html.replace(/<[^>]*>/g, ' ')).toContain('82%');
    expect(html).not.toContain('Context window');
  });

  it('还没有第一轮数据时不占位（不显示 0%）', () => {
    const previous = pillMocks.appState.contextHealth;
    pillMocks.appState.contextHealth = undefined as unknown as typeof previous;
    try {
      const html = renderToStaticMarkup(React.createElement(ContextUsagePill));
      expect(html).not.toContain('data-testid="context-usage-percent"');
    } finally {
      pillMocks.appState.contextHealth = previous;
    }
  });
});
