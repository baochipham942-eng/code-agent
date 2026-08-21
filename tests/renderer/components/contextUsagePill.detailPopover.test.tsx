// @vitest-environment jsdom
// ============================================================================
// ContextUsagePill — hover 气泡 / 点击开明细弹层 / context 深链（N-CTXPANEL 病A）
// 交互口径（2026-08-21 爸拍板）：hover 圆环出只读气泡，点击圆环展开长在输入框
// 上方的明细弹层（Cursor 同款不割裂形态）；分桶条/费用/压缩钮都在明细弹层里。
// 反向变异承重：删掉明细弹层的 ContextHealthPanel 挂载点，用例 2/4 必须红；
// 拿掉弹层顶部分桶条，用例 2 必须红。
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

function pillButton() {
  return screen.getByRole('button', { name: '上下文使用' });
}

function hoverPill() {
  // hover 处理挂在 wrapper div 上（onMouseEnter）；React 的 enter/leave 靠
  // mouseover/mouseout 冒泡合成，fireEvent.mouseEnter 不冒泡触发不到
  fireEvent.mouseOver(pillButton());
}

describe('ContextUsagePill — hover 气泡与明细弹层', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pillMocks.appState.contextHealth = contextHealth;
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(cleanup);

  it('hover 出只读气泡（% + token 数），气泡里没有分桶条和操作钮', () => {
    render(<ContextUsagePill />);
    hoverPill();

    expect(screen.getByText(/20% 已用/)).toBeTruthy();
    expect(screen.getByText(/2k \/ 10k Token/)).toBeTruthy();
    expect(screen.queryByTestId('context-source-bar')).toBeNull();
    expect(screen.queryByRole('button', { name: '立即压缩' })).toBeNull();
  });

  it('点击圆环直接打开明细弹层：分桶条 + 面板 bySource 区 + 摘要桶都在', () => {
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    // 弹层顶部分桶条：摘要段 title 带名称/token/占比
    const bar = screen.getByTestId('context-source-bar');
    expect(bar.innerHTML).toContain('摘要（压了 2 轮）');
    expect(bar.innerHTML).toContain('200');
    // 平铺桶清单（After 稿口径）：聚合类目中文名，0 值桶不占位
    const list = screen.getByTestId('context-bucket-list');
    expect(list.textContent).toContain('摘要（压了 2 轮）');
    expect(list.textContent).toContain('对话');
    expect(list.textContent).toContain('技能');
    expect(list.textContent).toContain('规则');
    // fixture 里 mcp/subagents/fileReads 为 0 → 不占位
    expect(list.textContent).not.toContain('连接器');
    expect(list.textContent).not.toContain('子代理');
    expect(list.textContent).not.toContain('文件读取');
  });

  it('bySource 全 0 时来源桶不占位（结构桶仍在）', () => {
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
    fireEvent.click(pillButton());

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    // bySource 全 0：来源桶不占位，但结构桶（系统提示 100）仍在清单里
    const list = screen.getByTestId('context-bucket-list');
    expect(list.textContent).toContain('系统提示');
    expect(list.textContent).not.toContain('对话');
  });

  it('context 深链（OPEN_CONTEXT_HEALTH_EVENT）直接打开明细弹层', () => {
    render(<ContextUsagePill />);

    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CONTEXT_HEALTH_EVENT));
    });

    expect(screen.getByText('上下文健康度明细')).toBeTruthy();
    expect(screen.getByTestId('context-bucket-list')).toBeTruthy();
  });

  it('明细弹层里压缩入口沿用 ≥70% 门槛：20% 不显示，80% 显示', () => {
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());
    expect(screen.queryByRole('button', { name: '立即压缩' })).toBeNull();
    cleanup();

    pillMocks.appState.contextHealth = { ...contextHealth, usagePercent: 80, warningLevel: 'warning' };
    render(<ContextUsagePill />);
    fireEvent.click(pillButton());
    expect(screen.getByRole('button', { name: '立即压缩' })).toBeTruthy();
  });
});
