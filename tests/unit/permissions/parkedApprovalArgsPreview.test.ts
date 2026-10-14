// ============================================================================
// 停车审批参数预览 + 跨重启引用（N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST）
// 判据：① argsPreview 脱敏（API key / Bearer / .env 值不留明文）且按常量截断；
// ② argsRef 仅在 sessionId 与 parentToolUseId 都在时写；③ 预览随 permission_request
// 事件下发会话卡。全部走公开入口 requestPermission + 注入 repo 断言 insert payload。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../src/shared/contract';
import type { PermissionRequest } from '../../../src/shared/contract/permission';
import type { ToolApprovalPayload } from '../../../src/shared/contract/pendingApproval';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { PARKED_APPROVAL_PREVIEW_MAX_CHARS } from '../../../src/shared/constants/pendingApproval';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

const settings = (overrides: Partial<AppSettings['permissions']> = {}): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
    ...overrides,
  },
} as AppSettings);

type InsertCall = { payload: ToolApprovalPayload };

function makeRepo() {
  const insert = vi.fn();
  return {
    repo: { insert, resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository,
    insert,
  };
}

function parkedPayload(insert: ReturnType<typeof vi.fn>): ToolApprovalPayload {
  expect(insert).toHaveBeenCalledOnce();
  return (insert.mock.calls[0] as unknown as [InsertCall])[0].payload;
}

describe('parkApproval 参数预览与 argsRef', () => {
  beforeEach(() => {
    resetPermissionModeManager();
  });

  afterEach(() => {
    resetPermissionModeManager();
  });

  function park(
    request: Partial<Omit<PermissionRequest, 'id' | 'timestamp'>>,
    insert: ReturnType<typeof vi.fn>,
    sessionId: string,
  ) {
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => false,
      onEvent: vi.fn(),
      injectedPendingApprovalRepo: { insert, resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository,
    });
    getPermissionModeManager().markUnattendedSession(sessionId);
    return island.requestPermission({
      type: 'command',
      tool: 'Bash',
      details: {},
      sessionId,
      ...request,
    });
  }

  it('sessionId 与 parentToolUseId 都在时写 argsRef（messageId 不发明）', () => {
    const { insert } = makeRepo();
    park({ details: { command: 'npm test' }, parentToolUseId: 'toolu_01ABC' }, insert, 'sess-argsref');

    const payload = parkedPayload(insert);
    expect(payload.argsRef).toEqual({ sessionId: 'sess-argsref', toolCallId: 'toolu_01ABC' });
    expect(payload.argsRef?.messageId).toBeUndefined();
  });

  it('缺 parentToolUseId 时不写 argsRef 键', () => {
    const { insert } = makeRepo();
    park({ details: { command: 'npm test' } }, insert, 'sess-noref');

    const payload = parkedPayload(insert);
    expect(payload.argsRef).toBeUndefined();
    expect('argsRef' in payload).toBe(false);
  });

  it('预览脱敏：API key / Bearer / .env 值不留明文（②）', () => {
    const { insert } = makeRepo();
    park({
      parentToolUseId: 'toolu_02SEC',
      details: {
        command: 'curl -H "Authorization: Bearer abcdefghijklmno" https://api.example.com/v1/chat',
        url: 'https://api.example.com/v1/chat?api_key=sk-abcdefgh12345678',
        changes: '写入 .env：OPENAI_API_KEY=sk-live-abcdefghijklmnop',
      },
    }, insert, 'sess-secrets');

    const preview = parkedPayload(insert).argsPreview;
    expect(preview).toBeDefined();
    // 明文密钥一律不得出现
    expect(preview).not.toContain('abcdefghijklmno');
    expect(preview).not.toContain('sk-abcdefgh12345678');
    expect(preview).not.toContain('sk-live-abcdefghijklmnop');
    expect(preview).not.toContain('secretvalue');
    // 被命中的位置换成掩码；非密钥正文保留（路径/URL 主体仍是可辨识信息）
    expect(preview).toContain('***REDACTED***');
    expect(preview).toContain('curl -H "Authorization: Bearer ***REDACTED***"');
    expect(preview).toContain('OPENAI_API_KEY=***REDACTED***');
    expect(preview).toContain('api.example.com');
  });

  it('预览按常量截断：最终长度不超过 PARKED_APPROVAL_PREVIEW_MAX_CHARS', () => {
    const { insert } = makeRepo();
    park({ details: { command: 'a'.repeat(500) } }, insert, 'sess-cap');

    const preview = parkedPayload(insert).argsPreview;
    expect(preview).toBeDefined();
    expect(preview!.length).toBe(PARKED_APPROVAL_PREVIEW_MAX_CHARS);
    expect(preview!.endsWith('…')).toBe(true);
  });

  it('无可预览字段时不写 argsPreview 键', () => {
    const { insert } = makeRepo();
    park({ details: {} }, insert, 'sess-empty');

    const payload = parkedPayload(insert);
    expect(payload.argsPreview).toBeUndefined();
    expect('argsPreview' in payload).toBe(false);
  });

  it('预览随 permission_request 事件下发会话卡（同一份内容）', () => {
    const { insert } = makeRepo();
    const onEvent = vi.fn();
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => false,
      onEvent,
      injectedPendingApprovalRepo: { insert, resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository,
    });
    getPermissionModeManager().markUnattendedSession('sess-event');
    void island.requestPermission({
      type: 'command',
      tool: 'Bash',
      details: { command: 'rm -rf /tmp/build' },
      sessionId: 'sess-event',
      parentToolUseId: 'toolu_03EVT',
    });

    const payload = parkedPayload(insert);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'permission_request',
      data: expect.objectContaining({ argsPreview: payload.argsPreview }),
    }));
  });
});
