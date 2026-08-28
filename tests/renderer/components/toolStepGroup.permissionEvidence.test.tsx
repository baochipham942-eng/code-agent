// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';

const state = vi.hoisted(() => ({
  resolved: [] as PermissionRequest[],
  pending: null as PermissionRequest | null,
  sendPrompt: vi.fn(async () => undefined),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (value: Record<string, unknown>) => unknown) => selector({
    resolvedPermissionRequests: { 'session-1': state.resolved },
    pendingPermissionRequest: state.pending,
    pendingPermissionSessionId: state.pending ? 'session-1' : null,
    queuedPermissionRequests: {},
    openPreview: vi.fn(),
    openSettingsTab: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (value: { sendPrompt: typeof state.sendPrompt }) => unknown) => selector({
    sendPrompt: state.sendPrompt,
  }),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

const toolNode: TraceNode = {
  id: 'node-tmeet',
  type: 'tool_call',
  content: '',
  timestamp: 1,
  toolCall: {
    id: 'call-tmeet',
    name: 'tmeetMeetingCreate',
    args: { subject: '临时会议' },
    stepLabel: 'tmeetMeetingCreate',
    result: 'ok',
    success: true,
  },
};

function resolved(decision: PermissionRequest['decision'], linked = true): PermissionRequest {
  return {
    id: `permission-${decision}`,
    sessionId: 'session-1',
    parentToolUseId: linked ? 'call-tmeet' : undefined,
    tool: 'tmeetMeetingCreate',
    type: 'file_write',
    details: { subject: '临时会议', start: '2026-08-26T09:00:00+08:00' } as PermissionRequest['details'],
    timestamp: 1,
    resolved: true,
    decision,
  };
}

afterEach(() => {
  cleanup();
  state.resolved = [];
  state.pending = null;
  state.sendPrompt.mockClear();
});

describe('ToolStepGroup resolved permission evidence', () => {
  it('待审批工具主行使用请求式，不抢跑完成时', () => {
    state.pending = {
      id: 'permission-pending', sessionId: 'session-1', parentToolUseId: 'call-tmeet',
      tool: 'tmeetMeetingCreate', type: 'file_write',
      details: { subject: '临时会议' } as PermissionRequest['details'], timestamp: 1,
    };
    const pendingNode: TraceNode = { ...toolNode, toolCall: { ...toolNode.toolCall!, result: undefined, success: undefined } };
    render(<ToolStepGroup nodes={[pendingNode]} sessionId="session-1" isStreamingTurn />);

    const header = screen.getAllByRole('button', { expanded: false })[0]?.textContent ?? '';
    expect(header).toContain('请求创建会议');
    expect(header).not.toContain('创建了一场会议');
  });

  it('把允许结果放到对应工具步骤旁，并在折叠区保留完整参数', () => {
    state.resolved = [resolved('once')];
    render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);

    const evidence = screen.getByTestId('permission-decision-evidence');
    expect(evidence.textContent).toContain('你已允许 · 创建腾讯会议 临时会议');
    expect(screen.getByTestId('permission-decision-details').textContent).toContain('2026-08-26T09:00:00+08:00');
    expect(screen.queryByTestId('permission-card')).toBeNull();
  });

  it('超时结果保留步骤旁重试入口', () => {
    state.resolved = [resolved('timeout')];
    render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);

    expect(screen.getByTestId('permission-decision-evidence').textContent).toContain('执行超时 · 等待回答或权限确认超时');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(state.sendPrompt).toHaveBeenCalledWith('刚才的审批超时了，请重试');
  });

  it('拒绝结果用审批终态词，并在组头和原因行说明为什么', () => {
    state.resolved = [resolved('deny')];
    const deniedNode: TraceNode = {
      ...toolNode,
      toolCall: {
        ...toolNode.toolCall!,
        result: 'Permission denied',
        success: false,
      },
    };
    render(<ToolStepGroup nodes={[deniedNode]} sessionId="session-1" />);

    const header = screen.getByRole('button', { expanded: false }).textContent ?? '';
    expect(header).toContain('未获批准');
    expect(header).toContain('审批被拒绝');
    expect(header).not.toContain('执行时出了问题');
    expect(screen.getByTestId('permission-decision-evidence').textContent).toContain('未获批准 · 审批被拒绝');
  });

  it('没有工具调用关联的旧请求不猜测归属', () => {
    state.resolved = [resolved('once', false)];
    render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);
    expect(screen.queryByTestId('permission-decision-evidence')).toBeNull();
  });
});
