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
      breakdown: {
        systemPrompt: 200,
        messages: 9100,
        toolResults: 200,
        bySource: {
          rules: 0,
          skills: { 'my-skill': 100 },
          mcp: {},
          subagents: {},
          fileReads: 0,
          conversation: 0,
        },
      },
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
  unmountSkill: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof panelMocks.appState) => unknown) => (
    selector ? selector(panelMocks.appState) : panelMocks.appState
  ),
}));

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: (selector?: (state: { unmountSkill: typeof panelMocks.unmountSkill }) => unknown) => {
    const state = { unmountSkill: panelMocks.unmountSkill };
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

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: toastMocks,
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

// D-2：handleUnload 的中文迁 i18n 后带插值（{name}/{message}），钉住替换是不是真按
// 消息内容/角色名把占位符填对，而不是只看"调用过 toast"这种不看参数的弱断言
// （D-1 回炉正是因为类似的"只断言调用过"漏了参数错误）。
describe('ContextPanel — handleUnload 卸载 skill toast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(cleanup);

  it('卸载成功：toast.success 内容把 {name} 换成 skill 名', async () => {
    panelMocks.unmountSkill.mockResolvedValue(undefined);
    render(<ContextPanel />);

    fireEvent.click(screen.getByRole('button', { name: '卸载或断开 my-skill' }));

    await waitFor(() => expect(panelMocks.unmountSkill).toHaveBeenCalledWith('my-skill'));
    expect(toastMocks.success).toHaveBeenCalledWith('已卸载 skill: my-skill');
  });

  it('卸载失败：toast.error 内容把 {message} 换成真实错误信息', async () => {
    panelMocks.unmountSkill.mockRejectedValue(new Error('disk full'));
    render(<ContextPanel />);

    fireEvent.click(screen.getByRole('button', { name: '卸载或断开 my-skill' }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('卸载失败: disk full'));
  });
});
