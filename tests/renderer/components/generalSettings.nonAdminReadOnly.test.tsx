// @vitest-environment jsdom
// N-PERMRULES-LOCAL-OWNER：非管理员（本机本人）现在可以编辑自己的 deny/ask/allow 规则
// （host 侧只对 permissions 的非规则键门控），规则框应可编辑、失焦即存；继承按钮 /
// 迁移确认按钮这些仍走 admin 门控的控件保持只读并给出提示。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      // N-PERMRULES-LOCAL-OWNER 后 host 对非 admin 的 get 原样带回 deny/ask/allow；
      // 故意返回未 ack 的 _legacyPermissions 把迁移横幅拉进场景。
      return {
        permissions: {
          inheritance: 'strict-inherit',
          deny: ['Bash(rm -rf *)'],
          ask: ['Write(/etc/*)'],
          allow: ['Read'],
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

describe('GeneralSettings non-admin permission controls (N-PERMRULES-LOCAL-OWNER)', () => {
  it('ships the admin-managed note copy in both zh and en', () => {
    expect(zhPerms.adminManagedNote).toBe('由管理员管理');
    expect(enSettingsCore.general.permissions.adminManagedNote).toBe('Managed by your administrator');
  });

  it('states the immediate-effect hint in both zh and en (no restart copy)', () => {
    expect(zhPerms.userRules.autoSaveHint).toBe('焦点离开输入框时自动保存，保存后立即生效。');
    expect(enSettingsCore.general.permissions.userRules.autoSaveHint)
      .toBe('Rules save automatically when the input loses focus and take effect immediately.');
  });

  it('shows a non-admin their own rules in editable boxes and saves on blur', async () => {
    const success = vi.spyOn(toast, 'success');
    const errorToast = vi.spyOn(toast, 'error');
    render(<GeneralSettings />);

    expect(await screen.findByText(zhPerms.migration.title)).toBeTruthy();

    const deny = ruleTextarea(/^Bash\(rm -rf \*\)/);
    const ask = ruleTextarea(/^Bash\(git push \*\)/);
    const allow = ruleTextarea(/^Read\(\*\)/);
    expect(deny.disabled).toBe(false);
    expect(ask.disabled).toBe(false);
    expect(allow.disabled).toBe(false);
    // 打开页面就能看到已保存的规则（host get 不再剥掉本人规则）。
    expect(deny.value).toBe('Bash(rm -rf *)');
    expect(ask.value).toBe('Write(/etc/*)');
    expect(allow.value).toBe('Read');

    fireEvent.change(deny, { target: { value: 'Bash(echo neo-deny-probe*)' } });
    fireEvent.blur(deny);

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: { deny: ['Bash(echo neo-deny-probe*)'] },
      });
    });
    expect(success).toHaveBeenCalledTimes(1);
    expect(errorToast).not.toHaveBeenCalled();
  });

  it('keeps inheritance and migration controls admin-only with a visible note, firing no settings set', async () => {
    const errorToast = vi.spyOn(toast, 'error');
    render(<GeneralSettings />);

    expect(await screen.findByText(zhPerms.migration.title)).toBeTruthy();
    expect(screen.getByText(zhPerms.adminManagedNote)).toBeTruthy();

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
