// @vitest-environment jsdom
// ============================================================================
// ContextUsagePill — 弹层分桶条 + 查看明细 modal + context 深链（N-CTXPANEL 病A）
// 反向变异承重：删掉明细 modal 的 ContextHealthPanel 挂载点，用例 2/3 必须红；
// 拿掉弹层分桶条，用例 1 必须红。
// ============================================================================

import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_CONTEXT_HEALTH_EVENT } from '../../../src/renderer/utils/workbenchViews';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';

const contextHealth: ContextHealthState = {
  currentTokens: 2000,
  maxTokens: 10000,
  usagePercent: 20,
  breakdown: {
    systemPrompt: 100,
    messages: 1900,
    toolResults: 0,
    bySource: {
      rules: 100,
      skills: { 'my-skill': 50 },
      mcp: {},
      subagents: {},
      fileReads: 0,
      summary: 200,
      conversation: 800,
    },
  },
  warningLevel: 'normal',
  estimatedTurnsRemaining: 10,
  lastUpdated: Date.now(),
  compression: { status: 'none', compressionCount: 2, totalSavedTokens: 5000 },
};

const pillMocks = vi.hoisted(() => ({
  appState: {
    contextHealth: undefined as ContextHealthState | undefined,
    openWorkbenchTab: vi.fn(),
    setActiveWorkbenchTab: vi.fn(),
    setWorkbenchHighlight: vi.fn(),
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
  invokeDomain: vi.fn(),
  refreshContextHealth: vi.fn(),
  unmountSkill: vi.fn(),
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

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: (selector?: (state: { unmountSkill: typeof pillMocks.unmountSkill }) => unknown) => {
    const state = { unmountSkill: pillMocks.unmountSkill };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: pillMocks.invoke,
    invokeDomain: pillMocks.invokeDomain,
  },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ContextUsagePill } from '../../../src/renderer/components/features/chat/ContextUsagePill';
import { useContextCompactionStore } from '../../../src/renderer/stores/contextCompactionStore';

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: '上下文使用' }));
}

describe('ContextUsagePill — 弹层分桶条与明细 modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pillMocks.appState.contextHealth = contextHealth;
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(cleanup);

  it('弹层出现分桶条，摘要段 hover title 带名称/token/占比', () => {
    render(<ContextUsagePill />);
    openPopover();

    const bar = screen.getByTestId('context-source-bar');
    expect(bar).toBeTruthy();
    // summary 段的 title：名称 + token 数 + 占比
    expect(bar.innerHTML).toContain('摘要（压了 2 轮）');
    expect(bar.innerHTML).toContain('200');
  });

  it('bySource 全 0 时不渲染分桶条', () => {
    pillMocks.appState.contextHealth = {
      ...contextHealth,
      breakdown: {
        ...contextHealth.breakdown,
        bySource: {
          rules: 0,
          skills: {},
          mcp: {},
          subagents: {},
          fileReads: 0,
          summary: 0,
          conversation: 0,
        },
      },
    };
    render(<ContextUsagePill />);
    openPopover();

    expect(screen.queryByTestId('context-source-bar')).toBeNull();
  });

  it('点「查看明细」打开 modal 并挂载 ContextHealthPanel（bySource 区可见）', () => {
    render(<ContextUsagePill />);
    openPopover();

    fireEvent.click(screen.getByRole('button', { name: '查看明细' }));

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    // 明细 modal 里挂的是现成 ContextHealthPanel：bySource 区与摘要桶都在
    expect(screen.getByText('按产品来源')).toBeTruthy();
    expect(screen.getByText('摘要（压了 2 轮）')).toBeTruthy();
  });

  it('context 深链（OPEN_CONTEXT_HEALTH_EVENT）直接打开明细 modal', () => {
    render(<ContextUsagePill />);

    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CONTEXT_HEALTH_EVENT));
    });

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    expect(screen.getByText('按产品来源')).toBeTruthy();
  });
});
