// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';

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

describe('ToolCallDisplay 停车审批收口结果', () => {
  it.each([
    describeParkedApprovalClosure('expired_after_restart_24h'),
    describeParkedApprovalClosure('args_unavailable'),
    describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable'),
  ])('折叠态直接读出「未执行 · %s」', (sentence) => {
    // 形状与 rejectLedgerToolApproval 写入台账的 result 一致：无 metadata。
    const toolCall: ToolCall = {
      id: 'parked-1',
      name: 'Bash',
      arguments: { command: 'sleep 30' },
      result: { toolCallId: 'parked-1', success: false, error: sentence, duration: 0 },
    };
    const view = render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
    const text = view.container.textContent ?? '';
    expect(text).toContain(`未执行 · ${sentence}`);
    expect(text).not.toMatch(/执行失败|暂无失败原因摘要|running|运行中/);
  });
});
