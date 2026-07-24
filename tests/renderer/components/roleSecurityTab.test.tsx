// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { RoleSecurityTab } from '../../../src/renderer/components/features/expert/RoleSecurityTab';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));

type Equipment = NonNullable<RolePanelDetail['equipment']>;

const equipment = (permissionPreset?: Equipment['permissionPreset']): Equipment => ({
  skills: [],
  tools: ['Read'],
  model: 'balanced',
  maxIterations: 30,
  availableSkills: [],
  availableTools: ['Read'],
  ...(permissionPreset ? { permissionPreset } : {}),
});

afterEach(() => cleanup());

describe('RoleSecurityTab', () => {
  it('未设置时高亮「跟随通用设置」', () => {
    render(<RoleSecurityTab equipment={equipment()} onSave={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByTestId('role-security-mode-follow').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('role-security-preset-strict').getAttribute('aria-pressed')).toBe('false');
  });

  it('点某一档 → onSave 收到该档位', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RoleSecurityTab equipment={equipment()} onSave={onSave} />);
    fireEvent.click(screen.getByTestId('role-security-preset-ci'));
    expect(onSave).toHaveBeenCalledWith({ permissionPreset: 'ci' });
  });

  it('点「跟随通用设置」→ onSave 收到 null（清除单独设置）', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RoleSecurityTab equipment={equipment('strict')} onSave={onSave} />);
    fireEvent.click(screen.getByTestId('role-security-mode-follow'));
    expect(onSave).toHaveBeenCalledWith({ permissionPreset: null });
  });

  it('绝对下限说明始终在场', () => {
    render(<RoleSecurityTab equipment={equipment('ci')} onSave={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByTestId('role-security-floor')).toBeTruthy();
  });
});
