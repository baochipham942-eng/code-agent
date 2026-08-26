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
import { decisionCardEn } from '../../../src/renderer/i18n/decisionCard';

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

const meetingRequest: PermissionRequest = {
  id: 'permission-tmeet-1',
  sessionId: 'request-session',
  tool: 'tmeetMeetingCreate',
  type: 'file_write',
  forceConfirm: true,
  details: {
    subject: 'quick meeting',
    start: '2026-08-26T09:00:00+08:00',
    end: '2026-08-26T09:30:00+08:00',
  } as PermissionRequest['details'],
  reason: '要在外部系统里写入（腾讯会议：创建会议），需要你确认',
  boundary: {
    id: 'connector.external_write',
    connectorName: '腾讯会议',
  },
  timestamp: 1,
};

const localMs = (hour: number, minute = 0) => new Date(2026, 7, 26, hour, minute).getTime();
const pad = (value: number) => String(value).padStart(2, '0');
const localIso = (date: Date) => {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
};
const localInput = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

function nativeRequest(
  id: string,
  tool: string,
  details: Record<string, unknown>,
  connectorName: string,
): PermissionRequest {
  return {
    id,
    sessionId: 'request-session',
    tool,
    type: 'file_write',
    forceConfirm: true,
    details: details as PermissionRequest['details'],
    boundary: { id: 'connector.external_write', connectorName },
    timestamp: 1,
  };
}

const calendarCreateRequest = nativeRequest('permission-calendar-create', 'calendar_create_event', {
  calendar: '工作',
  title: '季度评审会',
  start_ms: localMs(9),
  end_ms: localMs(9, 30),
  location: '3F-01',
}, '日历');
const calendarUpdateRequest = nativeRequest('permission-calendar-update', 'calendar_update_event', {
  calendar: '工作',
  event_uid: 'event-uid-1',
  title: '季度评审会',
  start_ms: localMs(10),
  end_ms: localMs(10, 30),
  location: '3F-02',
}, '日历');
const remindersCreateRequest = nativeRequest('permission-reminders-create', 'reminders_create', {
  list: '工作',
  title: '提交评审纪要',
  notes: '附上行动项',
  remind_at_ms: localMs(15),
}, '提醒事项');
const remindersUpdateRequest = nativeRequest('permission-reminders-update', 'reminders_update', {
  list: '工作',
  reminder_id: 'reminder-1',
  title: '提交最终评审纪要',
  notes: '补上负责人',
  remind_at_ms: localMs(16),
}, '提醒事项');

function enterEdit() {
  fireEvent.click(screen.getByRole('button', { name: /改一改再(发|创建|更新)/ }));
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
    releaseApprovalResponse(meetingRequest.id);
    releaseApprovalResponse(calendarCreateRequest.id);
    releaseApprovalResponse(calendarUpdateRequest.id);
    releaseApprovalResponse(remindersCreateRequest.id);
    releaseApprovalResponse(remindersUpdateRequest.id);
    releaseApprovalResponse('permission-reminders-no-time');
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

  it('腾讯会议查看态摊开主题和时间，并显示外部写回边界', () => {
    state.request = meetingRequest;
    render(<PermissionCard />);

    expect(screen.getByText('创建腾讯会议')).toBeTruthy();
    expect(screen.getByText('创建会议「quick meeting」？')).toBeTruthy();
    expect(screen.getByText('写入你的腾讯会议')).toBeTruthy();
    expect(screen.getByTestId('writeback-view-subject').textContent).toBe('quick meeting');
    expect(screen.getByTestId('writeback-view-start').textContent).toContain('2026');
    expect(screen.getByTestId('writeback-view-end').textContent).toContain('2026');
    expect(screen.getByTestId('writeback-irreversible').textContent)
      .toContain('模型补全的默认主题或时间可点「改一改再创建」调整');
    expect(screen.getByRole('button', { name: /改一改再创建/ })).toBeTruthy();
  });

  it('默认值可改提示有中英文卡面文案', () => {
    expect(decisionCardEn.decisionCard.permission.writeback.tmeetWriteWarning)
      .toContain('default subject or times filled by the model');
  });

  it('腾讯会议改主题和本地时间后把 ISO updatedArgs 直达一次性 allow 通道', async () => {
    state.request = meetingRequest;
    render(<PermissionCard />);
    fireEvent.click(screen.getByRole('button', { name: /改一改再创建/ }));
    fireEvent.change(screen.getByTestId('writeback-edit-subject'), { target: { value: 'product sync' } });
    const editedStart = new Date('2026-08-26T09:15:00+08:00');
    const startInput = screen.getByTestId('writeback-edit-start') as HTMLInputElement;
    expect(startInput.type).toBe('datetime-local');
    fireEvent.change(startInput, { target: { value: localInput(editedStart) } });
    fireEvent.click(screen.getByRole('button', { name: '按修改后创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        meetingRequest.id,
        'allow',
        meetingRequest.sessionId,
        {
          subject: 'product sync',
          start: localIso(editedStart),
          end: localIso(new Date('2026-08-26T09:30:00+08:00')),
        },
      );
    });
  });

  it.each([
    [calendarCreateRequest, '创建日历事件', ['calendar', 'title', 'start_ms', 'end_ms', 'location'], ['calendar']],
    [calendarUpdateRequest, '更新日历事件', ['calendar', 'event_uid', 'title', 'start_ms', 'end_ms', 'location'], ['calendar', 'event_uid']],
    [remindersCreateRequest, '新建提醒', ['list', 'title', 'notes', 'remind_at_ms'], ['list']],
    [remindersUpdateRequest, '更新提醒', ['list', 'reminder_id', 'title', 'notes', 'remind_at_ms'], ['list', 'reminder_id']],
  ] as const)('%s：查看态字段齐全，标识只展示不出编辑控件', (native, expectedTitle, viewFields, readonlyFields) => {
    state.request = native;
    render(<PermissionCard />);

    expect(screen.getByText(expectedTitle)).toBeTruthy();
    for (const field of viewFields) {
      if (field === 'notes') {
        expect(screen.getByTestId('writeback-view-content')).toBeTruthy();
      } else {
        expect(screen.getByTestId(`writeback-view-${field}`)).toBeTruthy();
      }
    }

    enterEdit();
    const readonlyFieldNames = new Set<string>(readonlyFields);
    for (const field of viewFields) {
      if (!readonlyFieldNames.has(field)) {
        expect(screen.getByTestId(`writeback-edit-${field}`)).toBeTruthy();
      }
    }
    for (const field of readonlyFields) {
      expect(screen.queryByTestId(`writeback-edit-${field}`)).toBeNull();
    }
  });

  it('日历创建改本地时间后回传 Unix ms，calendar 标识不进入 updatedArgs', async () => {
    state.request = calendarCreateRequest;
    render(<PermissionCard />);
    enterEdit();
    const input = screen.getByTestId('writeback-edit-start_ms') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    fireEvent.change(input, { target: { value: '2026-08-26T09:15' } });
    fireEvent.click(screen.getByRole('button', { name: '按修改后创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        calendarCreateRequest.id,
        'allow',
        calendarCreateRequest.sessionId,
        {
          title: '季度评审会',
          start_ms: localMs(9, 15),
          end_ms: localMs(9, 30),
          location: '3F-01',
        },
      );
    });
  });

  it('提醒创建改本地时间后回传 Unix ms', async () => {
    state.request = remindersCreateRequest;
    render(<PermissionCard />);
    enterEdit();
    const input = screen.getByTestId('writeback-edit-remind_at_ms') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-08-26T17:45' } });
    fireEvent.click(screen.getByRole('button', { name: '按修改后创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        remindersCreateRequest.id,
        'allow',
        remindersCreateRequest.sessionId,
        { title: '提交评审纪要', notes: '附上行动项', remind_at_ms: localMs(17, 45) },
      );
    });
  });

  it.each([
    [calendarUpdateRequest, 'start_ms', '2026-08-26T10:15', {
      title: '季度评审会', start_ms: localMs(10, 15), end_ms: localMs(10, 30), location: '3F-02',
    }],
    [remindersUpdateRequest, 'remind_at_ms', '2026-08-26T17:15', {
      title: '提交最终评审纪要', notes: '补上负责人', remind_at_ms: localMs(17, 15),
    }],
  ] as const)('%s：更新卡改时间后回传 Unix ms，标识不进入 updatedArgs', async (native, field, value, expectedArgs) => {
    state.request = native;
    render(<PermissionCard />);
    enterEdit();
    fireEvent.change(screen.getByTestId(`writeback-edit-${field}`), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '按修改后更新' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        native.id,
        'allow',
        native.sessionId,
        expectedArgs,
      );
    });
  });

  it('可选 datetime 为空时不进入 updatedArgs', async () => {
    state.request = nativeRequest('permission-reminders-no-time', 'reminders_create', {
      list: '工作',
      title: '整理行动项',
      notes: '',
    }, '提醒事项');
    render(<PermissionCard />);
    enterEdit();
    expect((screen.getByTestId('writeback-edit-remind_at_ms') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '按修改后创建' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        'permission-reminders-no-time',
        'allow',
        'request-session',
        { title: '整理行动项', notes: '' },
      );
    });
  });

  it('结束时间早于开始时间时禁用提交', async () => {
    state.request = calendarCreateRequest;
    render(<PermissionCard />);
    enterEdit();
    fireEvent.change(screen.getByTestId('writeback-edit-end_ms'), { target: { value: '2026-08-26T08:59' } });
    const submit = screen.getByRole('button', { name: '按修改后创建' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('决定后默认折成一行，展开后才显示会议参数', () => {
    state.request = { ...meetingRequest, resolved: true, decision: 'once' };
    render(<PermissionCard />);

    const summary = screen.getByTestId('permission-settled-summary');
    expect(summary.textContent).toContain('已允许 · 创建腾讯会议 quick meeting');
    expect(summary.textContent).toContain('允许一次');
    expect(screen.queryByTestId('writeback-fields-view')).toBeNull();

    fireEvent.click(summary);
    expect(screen.getByTestId('writeback-fields-view')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起审批详情' }));
    expect(screen.getByTestId('permission-settled-summary')).toBeTruthy();
  });
});
