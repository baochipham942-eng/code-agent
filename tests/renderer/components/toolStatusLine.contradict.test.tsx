// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ToolCall } from '../../../src/shared/contract';

const appState = {
  processingSessionIds: new Set<string>(),
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  openPreview: vi.fn(),
};

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => (
    selector ? selector(appState) : appState
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string | null }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: never[] }) => unknown) => selector({ tasks: [] }),
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null }),
}));
vi.mock('../../../src/renderer/utils/featureFlags', () => ({
  isSemanticToolUIEnabled: () => false,
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';

const CONTRADICTORY_TERMINALS = ['已中断', '未成功', '未执行', '应用重启时中断'] as const;

function presentTerminals(text: string): string[] {
  return CONTRADICTORY_TERMINALS.filter((word) => text.includes(word));
}

afterEach(cleanup);

describe('N-TOOLSTATUS-LINE-CONTRADICT rendering', () => {
  it('grep + 重启中断：状态行只有一个终态，不含 No matches', () => {
    const toolCall: ToolCall = {
      id: 'grep-weather',
      name: 'Grep',
      arguments: { pattern: 'weather' },
      result: {
        toolCallId: 'grep-weather',
        success: true,
        output: 'No matches found',
      },
    };
    render(
      <ToolCallDisplay
        toolCall={toolCall}
        index={0}
        total={1}
        statusOverride="interrupted"
        interruptionReason="app-restart"
      />,
    );
    const text = screen.getByTestId('interrupt-timeline-step').textContent ?? '';
    expect(presentTerminals(text)).toEqual(['应用重启时中断']);
    expect(text).toContain('搜索 weather');
    expect(text).not.toMatch(/No matches/i);
    expect(text).not.toContain('执行时出了问题');
  });

  it('edit /dev/null + 重启中断：不含未成功和执行时出了问题', () => {
    const toolCall: ToolCall = {
      id: 'edit-dev-null',
      name: 'Edit',
      arguments: { file_path: '/dev/null' },
      result: {
        toolCallId: 'edit-dev-null',
        success: false,
        error: 'ENOENT: no such file or directory',
      },
    };
    render(
      <ToolCallDisplay
        toolCall={toolCall}
        index={0}
        total={1}
        statusOverride="interrupted"
        interruptionReason="app-restart"
      />,
    );
    const text = screen.getByTestId('interrupt-timeline-step').textContent ?? '';
    expect(presentTerminals(text)).toEqual(['应用重启时中断']);
    expect(text).toContain('编辑 /dev/null');
    expect(text).not.toContain('未成功');
    expect(text).not.toContain('执行时出了问题');
  });
});
