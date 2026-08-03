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
  statusState: {
    sessionCost: 0,
    unknownCostTurns: 0,
    isStreaming: false,
  },
  invoke: vi.fn(),
  refreshContextHealth: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof pillMocks.appState) => unknown) => (
    selector ? selector(pillMocks.appState) : pillMocks.appState
  ),
}));

vi.mock('../../../src/renderer/stores/statusStore', () => ({
  useStatusStore: (selector: (state: typeof pillMocks.statusState) => unknown) => selector(pillMocks.statusState),
}));

vi.mock('../../../src/renderer/hooks/useBudgetStatus', () => ({
  useBudgetStatus: () => null,
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

  // 2026-07-26 底栏收敛拍板，推翻此前「折叠态必须有可读锚点」的决定：
  // 圆环讲进度，精确百分比只在 hover title 和展开面板——底栏不再常驻任何数字。
  it('折叠态只有一个圆环，百分比在 title 而不是常驻文本', () => {
    const html = renderToStaticMarkup(React.createElement(ContextUsagePill));

    expect(html).toContain('aria-label="上下文使用"');
    // 「标记」是 token 的机翻，中文里没这个说法也不帮任何人做决策（2026-08-01 改）
    expect(html).toContain('82% 已用 · 82k/100k Token');
    expect(html).not.toContain('标记');
    expect(html).toContain('<svg');
    expect(html).not.toContain('data-testid="context-usage-percent"');
    // 文本内容（剥掉标签和属性）里不得再出现常驻百分比
    expect(html.replace(/<[^>]*>/g, ' ')).not.toContain('82%');
    expect(html).not.toContain('Context window');
  });

  it('还没有第一轮数据时圆环照常渲染，不显示 0%', () => {
    const previous = pillMocks.appState.contextHealth;
    pillMocks.appState.contextHealth = undefined as unknown as typeof previous;
    try {
      const html = renderToStaticMarkup(React.createElement(ContextUsagePill));
      expect(html).toContain('<svg');
      expect(html.replace(/<[^>]*>/g, ' ')).not.toContain('0%');
    } finally {
      pillMocks.appState.contextHealth = previous;
    }
  });
});
