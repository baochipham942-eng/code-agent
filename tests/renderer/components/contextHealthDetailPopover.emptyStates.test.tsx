// @vitest-environment jsdom
// ============================================================================
// ContextHealthDetailPopover — 空态 / 等待态 / 实报态（N-HEALTH-EMPTY-STATES）
// 全零快照不许渲染「0% 已用」；空会话走 S-30+S-47，已发首条未实报走 S-31。
// ============================================================================

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';
import { createEmptyHealthState } from '../../../src/shared/contract/contextHealth';

const popoverMocks = vi.hoisted(() => ({
  appState: {
    contextHealth: null as ContextHealthState | null,
    openWorkbenchTab: vi.fn(),
    setActiveWorkbenchTab: vi.fn(),
    setWorkbenchHighlight: vi.fn(),
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  },
  statusState: {
    sessionCost: 0,
    unknownCostTurns: 0,
    isStreaming: false,
  },
  sessionState: {
    currentSessionId: 'session-1',
    messages: [] as Array<{ id: string; role: string; content: string; timestamp: number }>,
    refreshContextHealth: vi.fn(),
  },
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
  unmountSkill: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof popoverMocks.appState) => unknown) => (
    selector ? selector(popoverMocks.appState) : popoverMocks.appState
  ),
}));

vi.mock('../../../src/renderer/stores/statusStore', () => ({
  useStatusStore: (selector: (state: typeof popoverMocks.statusState) => unknown) => selector(popoverMocks.statusState),
}));

vi.mock('../../../src/renderer/hooks/useBudgetStatus', () => ({
  useBudgetStatus: () => null,
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => popoverMocks.sessionState,
  },
}));

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: (selector?: (state: { unmountSkill: typeof popoverMocks.unmountSkill }) => unknown) => {
    const state = { unmountSkill: popoverMocks.unmountSkill };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: popoverMocks.invoke,
    invokeDomain: popoverMocks.invokeDomain,
  },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  ContextHealthDetailPopover,
  resolveContextHealthDetailMode,
} from '../../../src/renderer/components/features/chat/ContextHealthDetailPopover';
import { useContextCompactionStore } from '../../../src/renderer/stores/contextCompactionStore';

function renderDetail() {
  render(<ContextHealthDetailPopover onClose={() => undefined} />);
  return screen.getByTestId('context-health-detail');
}

function allZeroSnapshot(): ContextHealthState {
  return createEmptyHealthState(128_000);
}

function reportedSnapshot(): ContextHealthState {
  return {
    currentTokens: 11_956,
    maxTokens: 128_000,
    usagePercent: 9.3,
    breakdown: {
      systemPrompt: 1000,
      messages: 10_956,
      toolResults: 0,
      bySource: {
        rules: 0,
        skills: {},
        mcp: {},
        subagents: {},
        fileReads: 0,
        summary: 0,
        conversation: 10_956,
      },
    },
    warningLevel: 'normal',
    estimatedTurnsRemaining: 10,
    lastUpdated: Date.now(),
    tokenSource: 'provider',
    compression: { status: 'none', compressionCount: 0, totalSavedTokens: 0 },
  };
}

describe('resolveContextHealthDetailMode', () => {
  it('快照缺失或全零且未发消息 → empty', () => {
    expect(resolveContextHealthDetailMode(null, false)).toBe('empty');
    expect(resolveContextHealthDetailMode(undefined, false)).toBe('empty');
    expect(resolveContextHealthDetailMode(allZeroSnapshot(), false)).toBe('empty');
  });

  it('全零或缺失快照且已发首条 → pending', () => {
    expect(resolveContextHealthDetailMode(allZeroSnapshot(), true)).toBe('pending');
    expect(resolveContextHealthDetailMode(null, true)).toBe('pending');
  });

  it('currentTokens>0 或 provider 非全零 → ready', () => {
    expect(resolveContextHealthDetailMode(reportedSnapshot(), false)).toBe('ready');
    expect(resolveContextHealthDetailMode(reportedSnapshot(), true)).toBe('ready');
    const estimatedWithTokens = { ...allZeroSnapshot(), currentTokens: 42, usagePercent: 1 };
    expect(resolveContextHealthDetailMode(estimatedWithTokens, false)).toBe('ready');
  });

  it('tokenSource=provider 的全零快照仍不是实报', () => {
    const providerZero = { ...allZeroSnapshot(), tokenSource: 'provider' as const };
    expect(resolveContextHealthDetailMode(providerZero, false)).toBe('empty');
    expect(resolveContextHealthDetailMode(providerZero, true)).toBe('pending');
  });
});

describe('ContextHealthDetailPopover — 空态 / 等待态 / 实报态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    popoverMocks.appState.contextHealth = null;
    popoverMocks.statusState.isStreaming = false;
    popoverMocks.statusState.sessionCost = 0;
    popoverMocks.statusState.unknownCostTurns = 0;
    popoverMocks.sessionState.messages = [];
    useContextCompactionStore.setState({ status: 'idle', result: null, error: null, updatedAt: 0 });
  });

  afterEach(cleanup);

  it('空态：contextHealth=null 时「暂无上下文数据。」与「还没有健康度信息」可见，不渲染 0% 已用', () => {
    popoverMocks.appState.contextHealth = null;
    const detail = renderDetail();
    expect(detail.textContent).toContain('暂无上下文数据。');
    expect(detail.textContent).toContain('还没有健康度信息');
    expect(detail.textContent).toContain('发送第一条消息后开始记录。');
    expect(detail.textContent).not.toContain('0% 已用');
    expect(detail.textContent).not.toContain('等待统计上下文容量');
  });

  it('空态：全零快照且未发消息同样走空态，不把 0% 当真数据', () => {
    popoverMocks.appState.contextHealth = allZeroSnapshot();
    const detail = renderDetail();
    expect(detail.textContent).toContain('暂无上下文数据。');
    expect(detail.textContent).toContain('还没有健康度信息');
    expect(detail.textContent).not.toContain('0% 已用');
    expect(detail.textContent).not.toContain('剩余 100%');
    expect(detail.textContent).not.toContain('等待统计上下文容量');
  });

  it('等待态：全零快照 + 已发 pending 消息时「等待统计上下文容量」可见', () => {
    popoverMocks.appState.contextHealth = allZeroSnapshot();
    popoverMocks.sessionState.messages = [
      { id: 'pending-1', role: 'user', content: 'hello', timestamp: 1 },
    ];
    const detail = renderDetail();
    expect(detail.textContent).toContain('等待统计上下文容量');
    expect(detail.textContent).toContain('数据马上回来。');
    expect(detail.textContent).not.toContain('0% 已用');
    expect(detail.textContent).not.toContain('暂无上下文数据。');
    expect(detail.textContent).not.toContain('还没有健康度信息');
  });

  it('实报态：currentTokens=11956 时百分比文案仍是现有格式', () => {
    popoverMocks.appState.contextHealth = reportedSnapshot();
    popoverMocks.sessionState.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
    ];
    const detail = renderDetail();
    expect(detail.textContent).toContain('9.3% 已用 · 剩余 91%');
    expect(detail.textContent).toContain('12.0k / 128.0k Token');
    expect(detail.textContent).not.toContain('暂无上下文数据。');
    expect(detail.textContent).not.toContain('等待统计上下文容量');
    expect(detail.textContent).not.toContain('还没有健康度信息');
  });
});
