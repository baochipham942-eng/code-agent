// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { enSettingsCore } from '../../../src/renderer/i18n/enSettingsCore';
import { toast } from '../../../src/renderer/hooks/useToast';

const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain, on: vi.fn(), off: vi.fn() },
}));

import { GeneralSettings, resolvePermissionRulesBlur } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';

const invalidCopy = enSettingsCore.general.permissions.userRules.invalid;
const zhInvalid = zh.settings.general.permissions.userRules.invalid;

function setCalls(): unknown[][] {
  return invokeDomain.mock.calls.filter((call) => call[1] === 'set');
}

describe('permission rule blur decision', () => {
  it('does not hand an invalid line to persist, and does hand a valid set', () => {
    expect(resolvePermissionRulesBlur('allow', 'Read\nBash(', invalidCopy)).toEqual({
      ok: false,
      message: `Bash(: ${invalidCopy.malformed}`,
    });
    expect(resolvePermissionRulesBlur('allow', 'Bash(git *)\n\nRead\n', invalidCopy)).toEqual({
      ok: true,
      rules: ['Bash(git *)', 'Read'],
    });
  });

  it('states that allowing every Bash command is not permitted', () => {
    const decision = resolvePermissionRulesBlur('allow', 'Bash(*)', invalidCopy);
    expect(decision).toEqual({
      ok: false,
      message: `Bash(*): ${invalidCopy.allowAllBash}`,
    });
    expect(invalidCopy.allowAllBash).toContain('Allowing every Bash command is not permitted');
    expect(invalidCopy.allowAllBash).toContain('ask list');
    expect(zhInvalid.allowAllBash).toContain('不允许放行全部 Bash 命令');
    expect(zhInvalid.allowAllBash).toContain('询问列表');
  });
});

describe('GeneralSettings permission rule editor', () => {
  beforeEach(() => {
    invoke.mockReset();
    invokeDomain.mockReset();
    invoke.mockResolvedValue(undefined);
    invokeDomain.mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return Promise.resolve({
          permissions: {
            inheritance: 'strict-inherit',
            deny: [],
            ask: [],
            allow: ['Read'],
          },
        });
      }
      if (domain === IPC_DOMAINS.SETTINGS && action === 'getBudgetStatus') {
        return Promise.resolve({ scopes: { unattended: { currentCost: 0 } } });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    cleanup();
  });

  async function renderEditor(): Promise<HTMLTextAreaElement> {
    render(<GeneralSettings />);
    const allow = await screen.findByDisplayValue('Read');
    return allow as HTMLTextAreaElement;
  }

  it('keeps an invalid line on screen and does not persist it, then persists a valid set', async () => {
    const allow = await renderEditor();
    const success = vi.spyOn(toast, 'success');

    fireEvent.change(allow, { target: { value: 'Bash(' } });
    fireEvent.blur(allow);

    expect(allow.value).toBe('Bash(');
    expect(screen.getByText(`Bash(: ${zhInvalid.malformed}`)).toBeTruthy();
    expect(setCalls()).toEqual([]);
    expect(success).not.toHaveBeenCalled();

    fireEvent.change(allow, { target: { value: 'Bash(git *)\nRead' } });
    fireEvent.blur(allow);

    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: { allow: ['Bash(git *)', 'Read'] },
      });
    });
    expect(screen.queryByText(`Bash(: ${zhInvalid.malformed}`)).toBeNull();
    expect(allow.value).toBe('Bash(git *)\nRead');
  });

  it('shows the allow-all Bash reason and does not persist', async () => {
    const allow = await renderEditor();

    fireEvent.change(allow, { target: { value: 'Bash(*)' } });
    fireEvent.blur(allow);

    expect(allow.value).toBe('Bash(*)');
    expect(screen.getByText(`Bash(*): ${zhInvalid.allowAllBash}`)).toBeTruthy();
    expect(setCalls()).toEqual([]);
  });
});
