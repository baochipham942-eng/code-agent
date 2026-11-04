// @vitest-environment jsdom
// N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU2：ADR-088 交回卡渲染判据（规格 §3）。
// 真 PermissionCard（store mock 骨架照抄 permissionCard.sandboxEscalate.test.tsx）：
// 请求形状 = toolExecutor decorateSensitiveStepRequest 的产物（host 测试同一组字段断言）。
// 判据：asking/waiting/终态各状态的按钮组与文案；全卡不出现「本会话允许 / 始终允许」；
// 应答只发 allow/deny（无新应答值）；被键入文本不进卡片；停车单状态卡（收件箱行）。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

const ipcInvoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh: zhMessages }, { en: enMessages }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return {
    useI18n: () => ({
      t: storeState.language === 'en' ? enMessages : zhMessages,
      language: storeState.language,
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: storeState.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    dismissPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: ipcInvoke },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');
const { SensitiveStepParkedRow } = await import('../../../src/renderer/components/PermissionDialog/SensitiveStepHandbackCard');

/** host decorateSensitiveStepRequest 的真实产物形状（与 orchestratorPermissions.cuaSensitiveStep.test.ts 同源）。 */
function handbackRequest(overrides: Partial<ContractPermissionRequest> = {}): ContractPermissionRequest {
  return {
    id: 'req-hb-1',
    sessionId: 's1',
    timestamp: 1,
    forceConfirm: true,
    type: 'dangerous_command',
    tool: 'mcp__cua-driver__type_text',
    reasonCode: 'sensitive_step_handback',
    reason: '这一步请你亲手完成',
    details: {
      sensitiveStep: { kind: 'password', elementLabel: 'Password', appName: 'Shop' },
      action: 'type_text',
    },
    ...overrides,
  } as ContractPermissionRequest;
}

function renderCard(id = 'req-hb-1'): ReturnType<typeof render> {
  // 每个用例唯一 id：approvalResponseGuard 的 claim 跨用例留在模块态，同 id 会被当重复点击吞掉
  storeState.request = handbackRequest({ id });
  return render(React.createElement(PermissionCard));
}

afterEach(() => {
  cleanup();
  storeState.language = 'zh';
  storeState.request = null;
  ipcInvoke.mockClear();
});

describe('sensitive step hand-back card (interactive state machine)', () => {
  it('asking: title + password body with {app}/{label}, buttons 我来完成 / 这步不做了, no remember options, no typed text', () => {
    const { container } = renderCard();
    expect(screen.getByText('这一步请你亲手完成')).toBeTruthy();
    expect(screen.getByText('Neo 不代填密码。请在 Shop 窗口的「Password」输入框里自己输入，输好后点下面的按钮继续。')).toBeTruthy();
    expect(screen.getByText('我来完成')).toBeTruthy();
    expect(screen.getByText('这步不做了')).toBeTruthy();
    // 全卡永不出现「记住」形态（规格 §3）
    expect(screen.queryByText('本会话允许')).toBeNull();
    expect(screen.queryByText('始终允许')).toBeNull();
    expect(screen.queryByText('允许一次')).toBeNull();
    expect(container.innerHTML).not.toContain('hunter2');
    expect(container.innerHTML).not.toContain('danger');
  });

  it('我来完成 only advances to waiting (no wire call); 完成后继续 then answers one-off allow', () => {
    renderCard('req-hb-allow');
    fireEvent.click(screen.getByText('我来完成'));
    // 状态推进但**不**裁决底层请求
    expect(ipcInvoke).not.toHaveBeenCalled();
    expect(screen.getByText('等你完成……完成后点「完成后继续」。')).toBeTruthy();
    expect(screen.getByText('完成后继续')).toBeTruthy();
    expect(screen.queryByText('我来完成')).toBeNull();
    fireEvent.click(screen.getByText('完成后继续'));
    expect(screen.getByText('这一步已由你亲手完成，Neo 没有执行它。')).toBeTruthy();
    expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', 'req-hb-allow', 'allow', 's1');
    // 终态行替代按钮
    expect(screen.queryByText('完成后继续')).toBeNull();
    expect(screen.queryByText('这步不做了')).toBeNull();
  });

  it('这步不做了 answers deny and shows the skipped terminal line (from asking and from waiting)', () => {
    renderCard('req-hb-deny1');
    fireEvent.click(screen.getByText('这步不做了'));
    expect(screen.getByText('这一步已跳过，Neo 没有执行它。')).toBeTruthy();
    expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', 'req-hb-deny1', 'deny', 's1');
    expect(ipcInvoke).toHaveBeenCalledTimes(1);
  });

  it('skip from the waiting state also answers deny exactly once', () => {
    renderCard('req-hb-deny2');
    fireEvent.click(screen.getByText('我来完成'));
    fireEvent.click(screen.getByText('这步不做了'));
    expect(screen.getByText('这一步已跳过，Neo 没有执行它。')).toBeTruthy();
    expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', 'req-hb-deny2', 'deny', 's1');
    expect(ipcInvoke).toHaveBeenCalledTimes(1);
  });

  it('english copy follows the language switch', () => {
    storeState.language = 'en';
    storeState.request = handbackRequest({ id: 'req-hb-en' });
    render(React.createElement(PermissionCard));
    expect(screen.getByText('Please do this step yourself')).toBeTruthy();
    expect(screen.getByText('Neo does not type passwords. Please type into the "Password" field in the Shop window yourself, then press the button below to continue.')).toBeTruthy();
    expect(screen.getByText("I'll do it")).toBeTruthy();
    expect(screen.getByText('Skip this step')).toBeTruthy();
    fireEvent.click(screen.getByText("I'll do it"));
    expect(screen.getByText('Waiting for you… press "Continue after done" when finished.')).toBeTruthy();
    fireEvent.click(screen.getByText('Continue after done'));
    expect(screen.getByText('You completed this step yourself; Neo did not perform it.')).toBeTruthy();
  });

  it('label and app fall back when the host omitted them', () => {
    storeState.request = handbackRequest({
      details: { sensitiveStep: { kind: 'password' }, action: 'type_text' },
    } as Partial<ContractPermissionRequest>);
    render(React.createElement(PermissionCard));
    expect(screen.getByText('Neo 不代填密码。请在 该应用 窗口的「密码输入框」输入框里自己输入，输好后点下面的按钮继续。')).toBeTruthy();
  });
});

describe('sensitive step parked row (inbox / session parked card)', () => {
  it('renders the single-state card: reminder line + body + [完成后继续]/[这步不做了], no standing-grant button', () => {
    const respond = vi.fn();
    const { container } = render(
      React.createElement(SensitiveStepParkedRow, {
        step: { kind: 'password', elementLabel: 'Password', appName: 'Shop' },
        onRespond: respond,
      }),
    );
    expect(screen.getByText('（无人值守任务挂起等你）')).toBeTruthy();
    expect(screen.getByText('Neo 不代填密码。请在 Shop 窗口的「Password」输入框里自己输入，输好后点下面的按钮继续。')).toBeTruthy();
    expect(screen.getByText('完成后继续')).toBeTruthy();
    expect(screen.getByText('这步不做了')).toBeTruthy();
    expect(container.innerHTML).not.toContain('每次都允许');
    fireEvent.click(screen.getByText('完成后继续'));
    expect(respond).toHaveBeenCalledWith('allow');
    fireEvent.click(screen.getByText('这步不做了'));
    expect(respond).toHaveBeenCalledWith('deny');
  });
});
