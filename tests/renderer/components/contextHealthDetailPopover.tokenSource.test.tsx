// @vitest-environment jsdom
// ============================================================================
// ContextHealthDetailPopover — 总量真源标注（N-CTXTRUTH 病B）
// 口径：tokenSource='provider' 时大数字行旁显示估/实偏差（本地估算相对实报）；
// 'estimated'（含老状态缺省）时显示「估算」标注，不显示偏差。
// 反向变异承重：删掉弹层的偏差/标注渲染分支，全部用例必须红。
// ============================================================================

import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';

function makeHealth(overrides: Partial<ContextHealthState>): ContextHealthState {
  return {
    currentTokens: 10000,
    maxTokens: 100000,
    usagePercent: 10,
    breakdown: {
      systemPrompt: 1000,
      messages: 9000,
      toolResults: 0,
      bySource: {
        rules: 0,
        skills: {},
        mcp: {},
        subagents: {},
        fileReads: 0,
        summary: 0,
        conversation: 9000,
      },
    },
    warningLevel: 'normal',
    estimatedTurnsRemaining: 10,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

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
  render(<ContextUsagePill />);
  fireEvent.click(screen.getByRole('button', { name: '上下文使用' }));
}

describe('ContextHealthDetailPopover — 总量真源标注（N-CTXTRUTH）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(cleanup);

  it('provider 实报轮次：显示估/实偏差，不显示「估算」标注', () => {
    // 估算 12000 vs 实报 10000 → 偏差 +20.0%
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      estimatedTokens: 12000,
    });
    openPopover();

    const deviation = screen.getByTestId('context-health-deviation');
    expect(deviation.textContent).toContain('+20.0%');
    expect(screen.queryByTestId('context-health-estimated-badge')).toBeNull();
  });

  it('provider 实报但偏差收敛到 0 时：不显示偏差（无信息量的噪声不出现在 UI）', () => {
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'provider',
      estimatedTokens: 10000,
    });
    openPopover();

    expect(screen.queryByTestId('context-health-deviation')).toBeNull();
    expect(screen.queryByTestId('context-health-estimated-badge')).toBeNull();
  });

  it('tokenSource=estimated：显示「估算」标注，即使有 estimatedTokens 也不显示偏差', () => {
    pillMocks.appState.contextHealth = makeHealth({
      tokenSource: 'estimated',
      estimatedTokens: 12000,
    });
    openPopover();

    expect(screen.getByTestId('context-health-estimated-badge').textContent).toContain('估算');
    expect(screen.queryByTestId('context-health-deviation')).toBeNull();
  });

  it('老状态缺省 tokenSource：视同 estimated，显示「估算」标注', () => {
    pillMocks.appState.contextHealth = makeHealth({});
    openPopover();

    expect(screen.getByTestId('context-health-estimated-badge').textContent).toContain('估算');
  });
});
