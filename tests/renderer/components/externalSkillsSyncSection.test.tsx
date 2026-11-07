// @vitest-environment jsdom
// ExternalSkillsSyncSection（N-EXTHISTORY-IMPORT-SYNC-CONTENT-SKILLS）：三态、keptNeo 行、不渲染原因码
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { ExternalSkillsSyncSection } from '../../../src/renderer/components/features/settings/tabs/ExternalSkillsSyncSection';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  invokeDomain.mockReset();
  useAppStore.setState({ language: 'zh' });
});
afterEach(() => cleanup());

describe('ExternalSkillsSyncSection', () => {
  it('默认 off：显示未开启，无暂停按钮，无 keptNeo 行', async () => {
    invokeDomain.mockResolvedValue({ mode: 'off' });
    render(<ExternalSkillsSyncSection />);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'getSkillsSync'));
    expect(screen.getByTestId('external-skills-sync-status').textContent).toBe('未开启');
    expect(screen.queryByText('暂停同步')).toBeNull();
    expect(screen.queryByTestId('external-skills-sync-kept-neo')).toBeNull();
  });

  it('打开开关 → setSkillsSync on；显示新增数与「保留 Neo 版本」行', async () => {
    invokeDomain.mockImplementation(async (_d: string, action: string) => (
      action === 'setSkillsSync'
        ? { mode: 'on', lastRun: { at: 1, imported: 2, keptNeo: 3 } }
        : { mode: 'off' }
    ));
    render(<ExternalSkillsSyncSection />);
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(screen.getByTestId('external-skills-sync-kept-neo').textContent).toBe('3 个技能已有同名技能，保留 Neo 版本'));
    expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'setSkillsSync', { mode: 'on' });
    expect(screen.getByTestId('external-skills-sync-status').textContent).toContain('新增 2 个');
  });

  it('paused：显示已暂停与恢复按钮；点恢复 → on', async () => {
    invokeDomain.mockImplementation(async (_d: string, action: string) => (
      action === 'setSkillsSync' ? { mode: 'on' } : { mode: 'paused' }
    ));
    render(<ExternalSkillsSyncSection />);
    await waitFor(() => expect(screen.getByTestId('external-skills-sync-status').textContent).toContain('已暂停'));
    fireEvent.click(screen.getByText('恢复同步'));
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'setSkillsSync', { mode: 'on' }));
  });

  it('IPC 失败只给固定文案', async () => {
    invokeDomain.mockImplementation(async (_d: string, action: string) => {
      if (action === 'setSkillsSync') throw new Error('EACCES /Users/x/secret');
      return { mode: 'off' };
    });
    render(<ExternalSkillsSyncSection />);
    fireEvent.click(await screen.findByRole('switch'));
    const err = await screen.findByTestId('external-skills-sync-error');
    expect(err.textContent).toBe('更新同步设置失败');
    expect(document.body.textContent).not.toContain('EACCES');
  });
});
