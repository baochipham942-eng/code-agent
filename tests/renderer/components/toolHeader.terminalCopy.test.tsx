// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/stores/appStore', () => {
  const state = {
    processingSessionIds: new Set<string>(),
    openPreview: vi.fn(),
    workingDirectory: '/repo',
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  };
  return {
    useAppStore: (selector?: (value: typeof state) => unknown) => selector ? selector(state) : state,
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';

afterEach(cleanup);

describe('ToolHeader terminal copy', () => {
  it('被拒绝的腾讯会议创建行只显示一次终态与原因，并把动作写成意图式', () => {
    const toolCall: ToolCall = {
      id: 'tmeet-denied-1',
      name: 'tmeetMeetingCreate',
      arguments: { subject: '临时会议' },
      stepLabel: 'tmeetMeetingCreate',
      result: {
        toolCallId: 'tmeet-denied-1',
        success: false,
        error: '审批失败',
        metadata: { code: 'PERMISSION_DENIED' },
      },
    };

    const view = render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
    const text = view.getByTestId('tool-call-row-tmeetMeetingCreate').textContent ?? '';

    expect(text.match(/未获批准/g)).toHaveLength(1);
    expect(text.match(/审批被拒绝/g)).toHaveLength(1);
    expect(text).toContain('创建会议');
    expect(text).not.toContain('创建了一场会议');
    expect(text).not.toContain('审批失败');
  });
});
