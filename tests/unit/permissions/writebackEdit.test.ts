// ============================================================================
// N-WRITEBACK-EDIT —— 审批卡「改一改再发」的参数流转机制
//
// 锁三件事：
//   1. 编辑后放行 → 工具真正收到的是编辑后参数（toolExecutor 唯一替换点），不可编辑字段原样带回；
//   2. fail-closed：表外字段 / 表外工具 / 配会话授权 → 不派发；
//   3. 无审批 UI 时，可编辑工具超时是 5 分钟，其余仍 60s。
// 反向变异：把 toolExecutor 里 `params = edited.params` 注掉，用例 1 必红。
// ============================================================================

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, PermissionAskResult, PermissionRequest } from '../../../src/shared/contract';
import { applyEditedArgs, EDITABLE_PERMISSION_TIMEOUT_MS } from '../../../src/shared/contract/permissionEdit';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getToolCache } from '../../../src/host/services/infra/toolCache';

const ORIGINAL = { subject: 'Q3 对账单', to: ['li.wei@acme.com'], content: '周五前确认', attachments: ['/tmp/q3.pdf'] };

describe('applyEditedArgs（共享合同）', () => {
  it('表内字段合并、附件原样带回、changedKeys 只记真改了的', () => {
    const r = applyEditedArgs('mail_send', ORIGINAL, { to: ['zhang.min@acme.com'], subject: 'Q3 对账单' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.to).toEqual(['zhang.min@acme.com']);
    expect(r.params.attachments).toEqual(['/tmp/q3.pdf']);
    expect(r.changedKeys).toEqual(['to']);
  });
  it.each([
    ['表外工具', 'Write', { to: ['x'] }],
    ['表外字段', 'mail_send', { attachments: ['/etc/passwd'] }],
    ['必填为空', 'mail_send', { to: [] }],
    ['类型不对', 'mail_send', { to: 'not-a-list' }],
  ])('fail-closed：%s', (_label, tool, updated) => {
    expect(applyEditedArgs(tool, ORIGINAL, updated as Record<string, unknown>).ok).toBe(false);
  });

  it('腾讯会议只允许改 schema 对应的主题、开始和结束时间', () => {
    const original = {
      subject: 'quick meeting',
      start: '2026-08-26T09:00:00+08:00',
      end: '2026-08-26T09:30:00+08:00',
      waiting_room: true,
    };
    const result = applyEditedArgs('tmeetMeetingCreate', original, {
      subject: 'product sync',
      start: '2026-08-26T10:00:00+08:00',
      end: '2026-08-26T10:45:00+08:00',
    });
    expect(result).toMatchObject({
      ok: true,
      params: { subject: 'product sync', waiting_room: true },
      changedKeys: ['subject', 'start', 'end'],
    });
    expect(applyEditedArgs('tmeetMeetingCreate', original, { waiting_room: false }).ok).toBe(false);
    expect(applyEditedArgs('tmeetMeetingCreate', original, { subject: '' }).ok).toBe(false);
  });

  it('日历时间按 Unix ms 往返，标识字段保持原值且不可编辑', () => {
    const original = {
      calendar: '工作',
      title: '评审会',
      start_ms: 1_777_346_400_000,
      end_ms: 1_777_348_200_000,
      event_uid: 'event-1',
    };
    const result = applyEditedArgs('calendar_update_event', original, {
      title: '季度评审会',
      start_ms: 1_777_350_000_000,
      end_ms: 1_777_351_800_000,
    });
    expect(result).toEqual({
      ok: true,
      params: {
        ...original,
        title: '季度评审会',
        start_ms: 1_777_350_000_000,
        end_ms: 1_777_351_800_000,
      },
      changedKeys: ['title', 'start_ms', 'end_ms'],
    });
    expect(applyEditedArgs('calendar_update_event', original, { event_uid: 'event-2' }).ok).toBe(false);
  });

  it.each([
    ['原生日历 end 早于 start', 'calendar_create_event', {
      calendar: '工作', title: '评审会', start_ms: 1_777_346_400_000, end_ms: 1_777_348_200_000,
    }, { start_ms: 1_777_350_000_000, end_ms: 1_777_349_000_000 }],
    ['腾讯会议 end 早于 start', 'tmeetMeetingCreate', {
      subject: '评审会', start: '2026-08-26T09:00:00+08:00', end: '2026-08-26T09:30:00+08:00',
    }, { start: '2026-08-26T10:00:00+08:00', end: '2026-08-26T09:59:00+08:00' }],
    ['必填 datetime 为空', 'calendar_create_event', {
      calendar: '工作', title: '评审会', start_ms: 1_777_346_400_000,
    }, { start_ms: '' }],
    ['非法 datetime', 'tmeetMeetingCreate', {
      subject: '评审会', start: '2026-08-26T09:00:00+08:00', end: '2026-08-26T09:30:00+08:00',
    }, { start: '明天上午九点' }],
  ])('fail-closed：%s', (_label, tool, original, updated) => {
    expect(applyEditedArgs(tool, original, updated).ok).toBe(false);
  });
});

describe('审批岛：改过的参数只配一次性放行 + 无 UI 时可编辑工具超时 5 分钟', () => {
  const settings = (): AppSettings => ({
    permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false },
  } as unknown as AppSettings);

  function ask(tool: string) {
    const events: { type: string; data: { id: string } }[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => false,
      onEvent: (e) => events.push(e as never),
    });
    const promise = island.requestPermission({ type: 'file_write', tool, details: { ...ORIGINAL } as unknown as PermissionRequest['details'], sessionId: 's1', forceConfirm: true });
    const id = events.find((e) => e.type === 'permission_request')?.data.id;
    if (!id) throw new Error('no permission_request event');
    return { island, promise, id };
  }

  beforeEach(() => { resetPermissionModeManager(); getPermissionModeManager(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); resetPermissionModeManager(); });

  it("'allow' + updatedArgs → 富结果带 updatedArgs", async () => {
    const { island, promise, id } = ask('mail_send');
    expect(island.handlePermissionResponse(id, 'allow', { to: ['b@x'] })).toBe('delivered');
    const result = (await promise) as PermissionAskResult;
    expect(result).toEqual({ approved: true, approvalSource: 'user', updatedArgs: { to: ['b@x'] } });
  });

  it("'allow_session' + updatedArgs → fail-closed 拒（改过的内容不能当授权记忆）", async () => {
    const { island, promise, id } = ask('mail_send');
    island.handlePermissionResponse(id, 'allow_session', { to: ['b@x'] });
    const result = (await promise) as PermissionAskResult;
    expect(result.approved).toBe(false);
    expect(result.denialSource).toBe('fail-closed');
  });

  it('mail_send 60s 不超时、5 分钟才超时；Write 仍 60s', async () => {
    const mail = ask('mail_send');
    const write = ask('Write');
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(await write.promise).toMatchObject({ approved: false, denialSource: 'timeout' });
    let settled = false;
    void mail.promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(EDITABLE_PERMISSION_TIMEOUT_MS);
    expect(await mail.promise).toMatchObject({ approved: false, denialSource: 'timeout' });
  });
});

describe('toolExecutor：编辑后放行 → 派发的就是编辑后的参数', () => {
  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(() => { getToolCache().clear(); resetPermissionModeManager(); });
  afterEach(() => { resetPermissionModeManager(); });

  function build(askResult: PermissionAskResult) {
    const dispatched: { tool: string; params: Record<string, unknown>; approved?: Record<string, unknown> }[] = [];
    const requests: unknown[] = [];
    const executor = new ToolExecutor({
      workingDirectory: process.cwd(),
      requestPermission: async (request) => { requests.push(request); return askResult; },
      dispatchTool: async (toolName, params, context) => {
        dispatched.push({ tool: toolName, params, approved: (context as { approvedToolCall?: { args: Record<string, unknown> } }).approvedToolCall?.args });
        return { success: true, result: 'sent' };
      },
    });
    executor.setAuditEnabled(false);
    return { executor, dispatched, requests };
  }

  it('改了收件人 → dispatchTool 与 approvedToolCall 收到的都是改后的收件人，附件原样', async () => {
    const { executor, dispatched, requests } = build({ approved: true, updatedArgs: { to: ['zhang.min@acme.com'], subject: 'Q3 对账单（改）' } });
    const result = await executor.execute('mail_send', { ...ORIGINAL }, { sessionId: 'edit-session' });
    expect(requests.length).toBe(1);
    expect(result.success).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].params.to).toEqual(['zhang.min@acme.com']);
    expect(dispatched[0].params.subject).toBe('Q3 对账单（改）');
    expect(dispatched[0].params.attachments).toEqual(['/tmp/q3.pdf']);
    expect(dispatched[0].approved?.to).toEqual(['zhang.min@acme.com']);
  });

  it('fail-closed：updatedArgs 带表外字段 → 工具不被调用', async () => {
    const { executor, dispatched } = build({ approved: true, updatedArgs: { attachments: ['/etc/passwd'] } });
    const result = await executor.execute('mail_send', { ...ORIGINAL }, { sessionId: 'edit-session' });
    expect(dispatched).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Edited arguments rejected');
  });

  it('fail-closed：表外工具（mail_draft）带 updatedArgs → 工具不被调用', async () => {
    const { executor, dispatched, requests } = build({ approved: true, updatedArgs: { content: 'x' } });
    const result = await executor.execute('mail_draft', { ...ORIGINAL }, { sessionId: 'edit-session' });
    expect(requests.length).toBe(1);
    expect(dispatched).toHaveLength(0);
    expect(result.success).toBe(false);
  });
});
