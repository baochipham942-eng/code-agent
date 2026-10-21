// ============================================================================
// 通用工具审批卡两档（N-PERM-GRANT-TIERS）—— 验收 ① 的 renderer 钉子
// ============================================================================
// 卡上恰好出现「到这次做完为止」「24 小时内允许」两个新档（替代 本会话允许/始终允许），
// forceConfirm / danger 时仍然隐藏；点两档发 allow_run / allow_24h 且不再写
// renderer 权限记忆（saveMemory）。真源在 host 侧 toolGrantStore。
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  sessionId: null as string | null,
}));
const invoke = vi.hoisted(() => vi.fn());
const saveMemory = vi.hoisted(() => vi.fn());
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
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn() },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const baseRequest = (overrides: Partial<PermissionRequest>): PermissionRequest => ({
  id: 'permission-tiers',
  sessionId: 'session-current',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/tmp/report.txt' },
  timestamp: 1,
  ...overrides,
});

describe('通用工具卡两档（N-PERM-GRANT-TIERS）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.sessionId = 'session-current';
  });

  afterEach(() => {
    cleanup();
    if (state.request) releaseApprovalResponse(state.request.id);
    vi.restoreAllMocks();
  });

  function renderFresh(request: PermissionRequest) {
    state.request = request;
    render(<PermissionCard />);
  }

  it('① 恰好两个新档替代 旧 会话/始终 两档，文案一字不差', () => {
    renderFresh(baseRequest({ id: 'tier-plain' }));

    expect(screen.getByRole('button', { name: /到这次做完为止/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /24 小时内允许/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /允许一次/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /拒绝/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /本会话允许/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /始终允许/ })).toBeNull();
  });

  it('① 点「到这次做完为止」发 allow_run，不写 renderer 权限记忆', async () => {
    renderFresh(baseRequest({ id: 'tier-run' }));

    fireEvent.click(screen.getByRole('button', { name: /到这次做完为止/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        'tier-run',
        'allow_run',
        'session-current',
      );
    });
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('① 点「24 小时内允许」发 allow_24h，不写 renderer 权限记忆', async () => {
    renderFresh(baseRequest({ id: 'tier-24h' }));

    fireEvent.click(screen.getByRole('button', { name: /24 小时内允许/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        'tier-24h',
        'allow_24h',
        'session-current',
      );
    });
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('① 快捷键 s/a 直发两档新值', async () => {
    renderFresh(baseRequest({ id: 'tier-hotkey' }));

    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
      'tier-hotkey',
      'allow_run',
      'session-current',
    ));

    const second = baseRequest({ id: 'tier-hotkey-2' });
    renderFresh(second);
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
      'tier-hotkey-2',
      'allow_24h',
      'session-current',
    ));
    expect(saveMemory).not.toHaveBeenCalled();
  });

  it('① forceConfirm 卡不出现两档（仍只有 允许一次/拒绝）', () => {
    renderFresh(baseRequest({ id: 'tier-force', forceConfirm: true }));

    expect(screen.queryByRole('button', { name: /到这次做完为止/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /24 小时内允许/ })).toBeNull();
    expect(screen.getByRole('button', { name: /允许一次/ })).toBeTruthy();
  });

  it('① 危险卡（danger）不出现两档', () => {
    renderFresh(baseRequest({
      id: 'tier-danger',
      type: 'dangerous_command',
      dangerLevel: 'danger',
      forceConfirm: true,
      details: { command: 'rm -rf /tmp/x' },
    }));

    expect(screen.queryByRole('button', { name: /到这次做完为止/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /24 小时内允许/ })).toBeNull();
    expect(screen.getByRole('button', { name: /仍然执行/ })).toBeTruthy();
  });

  it('① external 工具卡带 target 时也提供两档（host 侧按 target 精确匹配）', () => {
    renderFresh(baseRequest({
      id: 'tier-external',
      tool: 'mcp__feishu__send_message',
      type: 'mcp',
      riskClass: 'external',
      details: { server: 'feishu', toolName: 'send_message', standingGrantTarget: 'oc_team_chat' },
    }));

    expect(screen.getByRole('button', { name: /到这次做完为止/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /24 小时内允许/ })).toBeTruthy();
  });
});
