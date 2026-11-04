// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import type { TraceNode } from '../../../src/shared/contract/trace';

const { supersededRequest } = vi.hoisted(() => ({
  supersededRequest: {
    id: 'perm-1',
    type: 'file_delete',
    tool: 'Bash',
    details: { command: 'rm b.txt' },
    timestamp: 1,
    sessionId: 'session-1',
    parentToolUseId: 'call-1',
    resolved: true,
    decision: 'superseded',
  } as PermissionRequest,
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh: copy } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: copy, language: 'zh' }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: {
    processingSessionIds: Set<string>;
    openPreview: () => void;
    pendingPermissionRequest: null;
    pendingPermissionSessionId: null;
    queuedPermissionRequests: [];
    resolvedPermissionRequests: Record<string, PermissionRequest[]>;
  }) => unknown) => selector({
    processingSessionIds: new Set(),
    openPreview: vi.fn(),
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    queuedPermissionRequests: [],
    resolvedPermissionRequests: { 'session-1': [supersededRequest] },
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string; messages: [] }) => unknown) => (
    selector({ currentSessionId: 'session-1', messages: [] })
  ),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: [] }) => unknown) => selector({ tasks: [] }),
}));

vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null, refresh: vi.fn() }),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

describe('被新消息取代的审批卡', () => {
  it('步骤上显示取代，不显示拒绝、超时或重试', () => {
    const node: TraceNode = {
      id: 'tool-1',
      type: 'tool_call',
      content: '',
      timestamp: 1,
      toolCall: {
        id: 'call-1',
        name: 'Bash',
        args: { command: 'rm b.txt' },
        success: true,
        result: 'removed a.txt',
      },
    };
    const html = renderToStaticMarkup(<ToolStepGroup nodes={[node]} sessionId="session-1" />);
    const permission = zh.decisionCard.permission;
    expect(html).toContain(permission.settledSuperseded);
    expect(html).not.toContain(permission.settledDenied);
    expect(html).not.toContain(permission.settledTimeout);
    expect(html).not.toContain(permission.retry);
  });
});
