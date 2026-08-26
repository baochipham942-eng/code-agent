// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message, PermissionRequest, StreamRecoverySnapshot } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const normalRequest: PermissionRequest = {
  id: 'normal-request',
  sessionId: 'session-current',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/workspace/report.md' },
  timestamp: 1,
};

const secondNormalRequest: PermissionRequest = {
  id: 'second-normal-request',
  sessionId: 'session-current',
  tool: 'Read',
  type: 'file_read',
  details: { path: '/workspace/source.md' },
  timestamp: 2,
};

const dangerousRequest: PermissionRequest = {
  id: 'dangerous-request',
  sessionId: 'session-current',
  tool: 'Bash',
  type: 'dangerous_command',
  details: { command: 'rm -rf /workspace/dist' },
  timestamp: 3,
};

const writebackRequest = {
  id: 'writeback-request',
  sessionId: 'session-current',
  tool: 'mail_send',
  type: 'mcp',
  details: {
    to: ['team@example.com'],
    subject: 'Q3 复盘',
    content: '正文',
  },
  timestamp: 4,
} as unknown as PermissionRequest;

const storeState = vi.hoisted(() => ({
  pendingPermissionRequest: null as PermissionRequest | null,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, PermissionRequest[]>,
  setPendingPermissionRequest: vi.fn(),
  recordPermissionDecision: vi.fn(),
}));
const currentSession = vi.hoisted(() => ({ id: 'session-current' as string | null }));
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string | null }) => unknown) => (
    selector({ currentSessionId: currentSession.id })
  ),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));

import { DecisionSlot } from '../../../src/renderer/components/features/chat/DecisionSlot';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

describe('DecisionSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession.id = 'session-current';
    storeState.pendingPermissionRequest = null;
    storeState.pendingPermissionSessionId = null;
    storeState.queuedPermissionRequests = {};
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    for (const request of [normalRequest, secondNormalRequest, dangerousRequest, writebackRequest]) {
      releaseApprovalResponse(request.id);
    }
  });

  it('挂在 PinnedTodoBar 之下、输入区相邻位置，时间线 Footer 不再渲染已决权限卡', () => {
    const chatSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
      'utf8',
    );
    const traceSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/features/chat/TurnBasedTraceView.tsx'),
      'utf8',
    );
    const pinned = chatSource.indexOf('<PinnedTodoBar');
    const slot = chatSource.indexOf('<DecisionSlot streamInterruption={streamInterruptionDecision} />');
    const workflow = chatSource.indexOf('<WorkflowLaunchCard />');

    expect(pinned).toBeGreaterThan(0);
    expect(slot).toBeGreaterThan(pinned);
    expect(workflow).toBeGreaterThan(slot);
    expect(traceSource).not.toContain('PermissionCard');
    expect(traceSource).not.toContain('resolvedPermissionRequests');
    expect(traceSource).toContain('<div className="h-6" aria-hidden="true" />');
  });

  it('三张请求只展示危险卡，卡头显示剩余两项，并按展示请求 id 裁决', async () => {
    storeState.pendingPermissionRequest = normalRequest;
    storeState.pendingPermissionSessionId = 'session-current';
    storeState.queuedPermissionRequests = {
      'session-current': [secondNormalRequest, dangerousRequest],
    };

    render(<DecisionSlot />);

    const slot = screen.getByTestId('decision-slot');
    expect(slot.getAttribute('aria-label')).toBe('待你决定');
    expect(slot.className).toContain('chat-col-pad');
    expect(slot.className).not.toContain('overflow-y-auto');
    expect(screen.getByText('危险操作')).toBeTruthy();
    expect(screen.getByText('还有 2 项')).toBeTruthy();
    expect(screen.queryByText('创建文件')).toBeNull();
    expect(screen.getByTestId('permission-card-details-scroll').className).toContain('overflow-y-auto');
    expect(screen.getByTestId('permission-card-pinned-options').className).toContain('shrink-0');
    expect(screen.getByTestId('permission-card-actions').className).toContain('shrink-0');
    expect(screen.getByTestId('permission-card').className).not.toContain('px-4');
    expect(screen.getByTestId('permission-card').firstElementChild?.className).toContain(
      'max-h-[calc(100dvh-12rem)]',
    );
    expect(screen.getByTestId('permission-card').firstElementChild?.className).toContain('shadow-2xl');

    fireEvent.click(screen.getByRole('button', { name: /允许一次/u }));
    fireEvent.click(screen.getByRole('button', { name: '允许' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        dangerousRequest.id,
        'allow',
        dangerousRequest.sessionId,
      );
      expect(storeState.recordPermissionDecision).toHaveBeenCalledWith(
        dangerousRequest,
        'once',
        'session-current',
      );
    });
  });

  it('写回请求排在常规权限前，同级仍保持原队列顺序', () => {
    storeState.pendingPermissionRequest = normalRequest;
    storeState.pendingPermissionSessionId = 'session-current';
    storeState.queuedPermissionRequests = {
      'session-current': [writebackRequest, secondNormalRequest],
    };

    render(<DecisionSlot />);

    expect(screen.getByText('发送邮件')).toBeTruthy();
    expect(screen.getByText('还有 2 项')).toBeTruthy();
    expect(screen.queryByText('创建文件')).toBeNull();
  });

  it('常规权限卡默认高亮主按钮，Enter = 允许一次', async () => {
    storeState.pendingPermissionRequest = normalRequest;
    storeState.pendingPermissionSessionId = 'session-current';
    render(<DecisionSlot />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '允许' }));
    fireEvent.keyDown(window, { key: 'Enter' });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        normalRequest.id,
        'allow',
        normalRequest.sessionId,
      );
    });
  });

  it('危险卡与写回卡的 Enter 均无效', () => {
    storeState.pendingPermissionRequest = dangerousRequest;
    storeState.pendingPermissionSessionId = 'session-current';
    const view = render(<DecisionSlot />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '允许' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalled();

    view.unmount();
    storeState.pendingPermissionRequest = writebackRequest;
    render(<DecisionSlot />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '允许' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Esc 只收起，迷你条点击或再按 Esc 展开，全程不发裁决 IPC', () => {
    storeState.pendingPermissionRequest = normalRequest;
    storeState.pendingPermissionSessionId = 'session-current';
    render(<DecisionSlot />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('decision-slot-collapsed')).toBeTruthy();
    const alignmentContainer = screen.getByTestId('decision-slot-collapsed-container').parentElement;
    expect(alignmentContainer?.className).toContain('max-w-3xl');
    expect(alignmentContainer?.className).toContain('mx-auto');
    expect(alignmentContainer?.className).toContain('justify-end');
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('decision-slot-collapsed'));
    expect(screen.getByTestId('permission-card')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('permission-card')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('新请求到达时自动展开，不让新卡藏在迷你条后', () => {
    storeState.pendingPermissionRequest = normalRequest;
    storeState.pendingPermissionSessionId = 'session-current';
    const view = render(<DecisionSlot />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('decision-slot-collapsed')).toBeTruthy();

    storeState.queuedPermissionRequests = { 'session-current': [secondNormalRequest] };
    view.rerender(<DecisionSlot />);

    expect(screen.getByTestId('permission-card')).toBeTruthy();
    expect(screen.queryByTestId('decision-slot-collapsed')).toBeNull();
  });

  it('当前会话没有待决请求时不渲染槽位', () => {
    storeState.queuedPermissionRequests = {
      'session-other': [dangerousRequest],
    };

    const view = render(<DecisionSlot />);

    expect(view.container.innerHTML).toBe('');
  });

  it('流式中断收成一行槽位；继续复用原消息动作，成功后槽位消失', async () => {
    const snapshot: StreamRecoverySnapshot = {
      sessionId: 'session-current',
      turnId: 'interrupted-turn-1',
      content: '部分回复',
      reasoning: '',
      toolCalls: [{ id: 'write-1', name: 'Write', arguments: '{"file_path":"/workspace/report.md"}' }],
      estimatedTokens: 10,
      timestamp: 1,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: [],
    };
    const retryMessage: Message = {
      id: 'user-before-interrupt',
      role: 'user',
      content: '写一篇长文',
      timestamp: 0,
    };
    const onContinue = vi.fn().mockResolvedValue(true);

    render(<DecisionSlot streamInterruption={{ snapshot, retryMessage, onContinue }} />);

    const row = screen.getByTestId('stream-interruption-decision');
    expect(row.textContent).toContain('上次回复中断，写入 /workspace/report.md 未执行');
    expect(screen.queryByTestId('permission-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /继续/u }));

    await waitFor(() => expect(onContinue).toHaveBeenCalledWith(retryMessage));
    await waitFor(() => expect(screen.queryByTestId('decision-slot')).toBeNull());
  });

  it('Enter 触发同一继续 handler；放弃只清掉当前中断槽位', async () => {
    const snapshot = {
      sessionId: 'session-current',
      turnId: 'interrupted-turn-2',
      content: '',
      reasoning: '',
      toolCalls: [{ id: 'write-2', name: 'Write', arguments: '{}' }],
      estimatedTokens: 0,
      timestamp: 1,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: [],
    } as StreamRecoverySnapshot;
    const retryMessage = { id: 'u-2', role: 'user', content: '继续写', timestamp: 0 } as Message;
    const onContinue = vi.fn().mockResolvedValue(true);
    const first = render(<DecisionSlot streamInterruption={{ snapshot, retryMessage, onContinue }} />);

    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith(retryMessage));
    first.unmount();

    const abandonedSnapshot = { ...snapshot, turnId: 'interrupted-turn-3' };
    render(<DecisionSlot streamInterruption={{ snapshot: abandonedSnapshot, retryMessage, onContinue }} />);
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    expect(screen.queryByTestId('decision-slot')).toBeNull();
  });

  it('仅有 pending 权限请求时不把右栏内容信号置为 true', () => {
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/App.tsx'),
      'utf8',
    );
    const signalStart = appSource.indexOf('const hasTaskWorkbenchContent = (');
    const effectStart = appSource.indexOf('useEffect(() => {', signalStart);
    const activitySignal = appSource.slice(signalStart, effectStart);

    expect(signalStart).toBeGreaterThan(0);
    expect(effectStart).toBeGreaterThan(signalStart);
    expect(activitySignal).not.toMatch(/PermissionRequest|queuedPermissionRequests/u);
    expect(appSource).toContain('syncTaskWorkbenchForActivity(hasTaskWorkbenchContent)');
  });
});
