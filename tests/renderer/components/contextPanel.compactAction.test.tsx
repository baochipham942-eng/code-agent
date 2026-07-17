// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

const panelMocks = vi.hoisted(() => ({
  appState: {
    contextHealth: {
      currentTokens: 9500,
      maxTokens: 10000,
      usagePercent: 95,
      breakdown: { systemPrompt: 200, messages: 9100, toolResults: 200 },
      warningLevel: 'critical' as const,
      estimatedTurnsRemaining: 1,
      lastUpdated: Date.now(),
    },
    openWorkbenchTab: vi.fn(),
    setActiveWorkbenchTab: vi.fn(),
    setWorkbenchHighlight: vi.fn(),
    // ContextHealthPanel 内部用 useI18n()，无 selector 整取 store，这几个字段得在。
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  },
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  refreshContextHealth: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof panelMocks.appState) => unknown) => (
    selector ? selector(panelMocks.appState) : panelMocks.appState
  ),
}));

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: (selector?: (state: { unmountSkill: () => void }) => unknown) => {
    const state = { unmountSkill: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      currentSessionId: 'session-1',
      refreshContextHealth: panelMocks.refreshContextHealth,
    }),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: panelMocks.invoke,
    invokeDomain: panelMocks.invokeDomain,
  },
}));

import { ContextPanel } from '../../../src/renderer/components/ContextPanel';
import { useContextCompactionStore } from '../../../src/renderer/stores/contextCompactionStore';

// C-4：ContextPanel 是 ContextHealthPanel 的 handler 容器，照抄 ContextUsagePill 的
// handleCompact 套路（useContextCompactionStore 单例守重入 + IPC + refreshContextHealth）。
describe('ContextPanel — 立即压缩 handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(cleanup);

  it('点击立即压缩：invoke CONTEXT_COMPACT_CURRENT 带当前 sessionId，成功后刷新健康数据', async () => {
    panelMocks.invoke.mockResolvedValue({
      success: true,
      beforeTokens: 9500,
      afterTokens: 4000,
      savedTokens: 5500,
      beforePercent: 95,
      afterPercent: 40,
      layersUsed: ['summary'],
      retained: { recentTurns: 3 },
    });

    render(<ContextPanel />);
    fireEvent.click(screen.getByRole('button', { name: '立即压缩' }));

    await waitFor(() => expect(panelMocks.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_COMPACT_CURRENT, 'session-1'));
    await waitFor(() => expect(panelMocks.refreshContextHealth).toHaveBeenCalledWith('session-1'));
  });

  it('已在压缩中（store status=active）：按钮 disabled，点击不重复触发', () => {
    useContextCompactionStore.setState({ status: 'active', result: null, error: null, updatedAt: Date.now() });
    render(<ContextPanel />);

    const button = screen.getByRole('button', { name: '压缩中…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(panelMocks.invoke).not.toHaveBeenCalled();
  });
});
