// @vitest-environment jsdom
// ============================================================================
// TurnDiffSummary 展开态稳定（X5.5-B2）
//
// 钉的是工单拍的稳定规则：
// - 执行中（streaming）默认收起，程序不自动弹开；
// - 用户手动展开/收起的状态活过重挂载（虚拟列表卸载/重挂载是根因场景）；
// - 展开态按 sessionId:turnId 键控，别的会话不串。
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TraceTurn } from '../../../src/shared/contract/trace';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: mocks.invoke,
    invokeDomain: mocks.invokeDomain,
  },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { TurnDiffSummary } from '../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary';
import { clearTurnDiffExpansionForTests } from '../../../src/renderer/utils/turnDiffExpansionState';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function makeTurn(overrides: Partial<TraceTurn> = {}): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'streaming',
    startTime: 100,
    nodes: [
      {
        id: 'tool-1',
        type: 'tool_call',
        content: '',
        timestamp: 150,
        toolCall: {
          id: 'tool-1',
          name: 'Write',
          args: { file_path: '/tmp/example.ts', content: 'export const value = 1;' },
          result: 'Created file: /tmp/example.ts',
          success: true,
        },
      },
    ],
    ...overrides,
  } as TraceTurn;
}

// 文件行按钮：完整路径在 title 上，用 title 锚定最稳
const fileRow = () => screen.getByTitle('/tmp/example.ts').closest('button')!;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invokeDomain.mockReset();
  clearTurnDiffExpansionForTests();
  useSessionStore.setState({ currentSessionId: 'session-1' });
});

afterEach(cleanup);

describe('TurnDiffSummary 展开态稳定（X5.5-B2）', () => {
  it('执行中默认收起，程序不自动弹开', () => {
    render(<TurnDiffSummary turn={makeTurn()} />);
    expect(fileRow().getAttribute('aria-expanded')).toBe('false');
  });

  it('手动展开活过重挂载（虚拟列表卸载/重挂载场景）', () => {
    const first = render(<TurnDiffSummary turn={makeTurn()} />);
    fireEvent.click(fileRow());
    expect(fileRow().getAttribute('aria-expanded')).toBe('true');

    first.unmount();

    render(<TurnDiffSummary turn={makeTurn()} />);
    expect(fileRow().getAttribute('aria-expanded')).toBe('true');
  });

  it('手动收起同样活过重挂载——程序不替用户改回', () => {
    const first = render(<TurnDiffSummary turn={makeTurn()} />);
    fireEvent.click(fileRow()); // 展开
    fireEvent.click(fileRow()); // 再收起
    expect(fileRow().getAttribute('aria-expanded')).toBe('false');
    first.unmount();

    // 先展开留着，再换个「会话」确认键控隔离：别的会话不继承展开态
    const second = render(<TurnDiffSummary turn={makeTurn()} />);
    fireEvent.click(fileRow());
    second.unmount();

    useSessionStore.setState({ currentSessionId: 'session-2' });
    render(<TurnDiffSummary turn={makeTurn()} />);
    expect(fileRow().getAttribute('aria-expanded')).toBe('false');
  });
});
