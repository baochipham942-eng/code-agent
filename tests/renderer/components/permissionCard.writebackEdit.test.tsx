// @vitest-environment jsdom
// ============================================================================
// N-WRITEBACK-EDIT —— 审批卡「改一改再发」编辑态（renderer 侧）
//   正向：改收件人 → 点「按修改后发送」→ IPC 第 5 参带改后的 updatedArgs
//   fail-closed：只改不点 / 收件人清空 / 编辑态按 y / 放弃修改 → IPC 零调用
//   呈现：查看态正文上屏、卡头是「发送邮件」不是「危险操作」
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null, sessionId: null as string | null }));
const invoke = vi.hoisted(() => vi.fn());
const setPendingPermissionRequest = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: state.sessionId,
    setPendingPermissionRequest,
    language: 'zh',
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

// host 默认分支：details = {...params} + 透传字段；mail_send 是 write 级 ⇒ type file_write、risk high ⇒ danger
const request: PermissionRequest = {
  id: 'permission-mail-1',
  sessionId: 'request-session',
  tool: 'mail_send',
  type: 'file_write',
  forceConfirm: true,
  dangerLevel: 'danger',
  details: {
    subject: 'Q3 供应商对账单',
    to: ['li.wei@acme.com'],
    cc: ['finance@acme.com'],
    content: '李伟你好，\n附件是 Q3 对账单，请在周五前确认。',
    attachments: ['/Users/me/Q3.pdf'],
  } as PermissionRequest['details'],
  timestamp: 1,
};

function enterEdit() {
  fireEvent.click(screen.getByRole('button', { name: /改一改再发/ }));
}
const toInput = () => screen.getByTestId('writeback-edit-to') as HTMLInputElement;
const sendEdited = () => screen.getByRole('button', { name: '按修改后发送' });

describe('PermissionCard · mail_send 改一改再发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(undefined);
    state.request = request;
    state.sessionId = 'session-current';
  });
  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
  });

  it('查看态：卡头是「发送邮件」，正文上屏，不再是危险命令红卡', () => {
    render(<PermissionCard />);
    expect(screen.getByText('发送邮件')).toBeTruthy();
    expect(screen.queryByText('危险操作')).toBeNull();
    expect(screen.getByTestId('writeback-view-content').textContent).toContain('请在周五前确认');
    expect(screen.getByText('发这封邮件给 li.wei@acme.com？')).toBeTruthy();
    expect(screen.getByText('改一改再发')).toBeTruthy();
  });

  it('改收件人 → 按修改后发送 → IPC 带改后的 updatedArgs，response 是一次性 allow', async () => {
    render(<PermissionCard />);
    enterEdit();
    fireEvent.change(toInput(), { target: { value: 'li.wei@acme.com, zhang.min@acme.com' } });
    fireEvent.click(sendEdited());
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        request.id,
        'allow',
        request.sessionId,
        {
          to: ['li.wei@acme.com', 'zhang.min@acme.com'],
          cc: ['finance@acme.com'],
          bcc: [],
          subject: 'Q3 供应商对账单',
          content: '李伟你好，\n附件是 Q3 对账单，请在周五前确认。',
        },
      );
    });
  });

  it('fail-closed：只改不点 → 不发；收件人清空 → 主按钮禁用且不发', async () => {
    render(<PermissionCard />);
    enterEdit();
    fireEvent.change(toInput(), { target: { value: 'zhang.min@acme.com' } });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(toInput(), { target: { value: '' } });
    expect((sendEdited() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sendEdited());
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fail-closed：编辑态里按 y 不会把原稿发出去；放弃修改回查看态也不发', async () => {
    render(<PermissionCard />);
    enterEdit();
    fireEvent.keyDown(window, { key: 'y' });
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(screen.queryByTestId('writeback-edit-form')).toBeNull();
    expect(screen.getByTestId('writeback-fields-view')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('不改直接「发送」→ IPC 不带第 5 参（走原参数，旧调用形状不变）', async () => {
    render(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: /^发送/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, request.id, 'allow', request.sessionId);
      expect(invoke.mock.calls[0]).toHaveLength(4);
    });
  });
});
