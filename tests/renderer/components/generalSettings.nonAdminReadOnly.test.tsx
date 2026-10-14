// @vitest-environment jsdom
// N-PERMRULES-UI-FIX-ADMIN：非管理员对规则 textarea / 子 Agent 继承按钮 / 迁移确认按钮
// 这些必走 settings set（host guard 对 'permissions' 恒 403）的控件，应在 UI 层
// 直接只读并给出提示，而不是让用户填完才吃 saveFailedPrefix 报错。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zhSettingsCore } from '../../../src/renderer/i18n/zhSettingsCore';
import { enSettingsCore } from '../../../src/renderer/i18n/enSettingsCore';
import { toast } from '../../../src/renderer/hooks/useToast';

const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain, on: vi.fn(), off: vi.fn() },
}));

import { GeneralSettings } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';

const zhPerms = zhSettingsCore.general.permissions;

function setCalls(): unknown[][] {
  return invokeDomain.mock.calls.filter((call) => call[1] === 'set');
}

beforeEach(() => {
  invoke.mockReset();
  invokeDomain.mockReset();
  invokeDomain.mockImplementation(async (_domain: string, action: string) => {
    if (action === 'get') {
      // host 对非管理员的 get 本会剥掉 deny/ask/allow/_legacyPermissions
      // （settings.ipc.ts sanitizeSettingsForUser）；这里故意返回未 ack 的
      // _legacyPermissions 把迁移横幅拉进场景——被测的是 renderer 门禁，不是 host 剥除。
      return {
        permissions: {
          inheritance: 'strict-inherit',
          _legacyPermissions: true,
        },
      };
    }
    if (action === 'getBudgetStatus') return {};
    return undefined;
  });
  useAppStore.setState({ language: 'zh' });
  useAuthStore.setState({ user: { id: 'test-nonadmin', email: 'user@test.dev', isAdmin: false } });
});

afterEach(cleanup);

// 占位符里带换行，testing-library 会把节点文本空白折叠，用前缀正则定位。
function ruleTextarea(placeholder: RegExp): HTMLTextAreaElement {
  return screen.getByPlaceholderText(placeholder) as HTMLTextAreaElement;
}

function actionButtonInRow(rowTitle: string): HTMLButtonElement {
  const row = screen.getByText(rowTitle).closest('tr');
  const button = row?.querySelector('button');
  if (!button) throw new Error(`Missing action button in row ${rowTitle}`);
  return button;
}

describe('GeneralSettings non-admin read-only permission controls (N-PERMRULES-UI-FIX-ADMIN)', () => {
  it('ships the admin-managed note copy in both zh and en', () => {
    expect(zhPerms.adminManagedNote).toBe('由管理员管理');
    expect(enSettingsCore.general.permissions.adminManagedNote).toBe('Managed by your administrator');
  });

  it('disables rules/inheritance/migration controls with a visible note, and fires no settings set nor error toast', async () => {
    const errorToast = vi.spyOn(toast, 'error');
    render(<GeneralSettings />);

    expect(await screen.findByText(zhPerms.migration.title)).toBeTruthy();
    expect(screen.getByText(zhPerms.adminManagedNote)).toBeTruthy();

    const deny = ruleTextarea(/^Bash\(rm -rf \*\)/);
    const ask = ruleTextarea(/^Bash\(git push \*\)/);
    const allow = ruleTextarea(/^Read\(\*\)/);
    expect(deny.disabled).toBe(true);
    expect(ask.disabled).toBe(true);
    expect(allow.disabled).toBe(true);

    // jsdom 对 disabled 元素照样派发事件（真实浏览器也存在合成/边界路径），
    // 这正是 handler 层还要再拦一道的原因：blur 也必须零 set。
    fireEvent.change(deny, { target: { value: 'Write(/etc/*)' } });
    fireEvent.blur(deny);
    fireEvent.blur(ask);
    fireEvent.change(allow, { target: { value: 'Bash(npm test)' } });
    fireEvent.blur(allow);

    const childNarrow = actionButtonInRow(zhPerms.inheritanceModes.childNarrow.title);
    const independent = actionButtonInRow(zhPerms.inheritanceModes.independent.title);
    expect(childNarrow.disabled).toBe(true);
    expect(independent.disabled).toBe(true);
    fireEvent.click(childNarrow);
    fireEvent.click(independent);

    const banner = screen.getByText(zhPerms.migration.title).closest<HTMLElement>('div.rounded-lg');
    if (!banner) throw new Error('Migration banner root not found');
    const ack = within(banner).getByRole('button', { name: zhPerms.migration.acknowledge }) as HTMLButtonElement;
    const close = within(banner).getByRole('button', { name: '关闭' }) as HTMLButtonElement;
    expect(ack.disabled).toBe(true);
    expect(close.disabled).toBe(true);
    fireEvent.click(ack);
    fireEvent.click(close);

    expect(setCalls()).toEqual([]);
    expect(errorToast).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
