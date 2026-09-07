// @vitest-environment jsdom
// spawn_agent worktree 失败行：一句人话原因，不再叠 missing + fallback。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';

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
  }) => unknown) => selector({
    processingSessionIds: new Set(),
    openPreview: vi.fn(),
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    queuedPermissionRequests: [],
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: [] }) => unknown) => selector({ tasks: [] }),
}));

vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null, refresh: vi.fn() }),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { TraceNode } from '../../../src/shared/contract/trace';

function spawnWorktreeFailCall(): ToolCall {
  return {
    id: 'spawn-1',
    name: 'spawn_agent',
    arguments: { description: '核对清单' },
    result: {
      toolCallId: 'spawn-1',
      success: false,
      error: 'Failed to create worktree for agent: dummy. Inspect worktree setup and resolve its error before retrying.',
      metadata: { failureCode: 'worktree-create-failed' },
    },
  };
}

describe('工具失败行一句人话', () => {
  it('spawn_agent worktree 失败行只显示一句人话原因，不叠四层文案', () => {
    const html = renderToStaticMarkup(
      <ToolCallDisplay toolCall={spawnWorktreeFailCall()} index={0} total={1} />,
    );
    const reason = zh.toolStepHumanize.failureCodes['worktree-create-failed'];
    expect(html).toContain(reason);
    expect(html).not.toContain(zh.toolStepHumanize.failureReasonMissing);
    expect(html).not.toContain(zh.systemError.fallbackSummary);
    expect((html.match(new RegExp(reason, 'g')) ?? []).length).toBe(1);
  });

  it('ToolStepGroup 组头失败 reason 与右侧摘要去重', () => {
    const node: TraceNode = {
      id: 'tool-1',
      type: 'tool_call',
      content: '',
      timestamp: 1,
      toolCall: {
        id: 'call-1',
        name: 'Bash',
        args: {},
        success: false,
        result: 'command failed with exit code 1',
        metadata: { failureCode: 'worktree-create-failed' },
      },
    };
    const html = renderToStaticMarkup(<ToolStepGroup nodes={[node]} />);
    const reason = zh.toolStepHumanize.failureCodes['worktree-create-failed'];
    expect(html).toContain(reason);
    expect(html).not.toContain(zh.toolStepHumanize.failureReasonMissing);
    expect(html).not.toContain(zh.systemError.fallbackSummary);
  });
});
