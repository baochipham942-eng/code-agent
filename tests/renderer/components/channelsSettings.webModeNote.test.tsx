// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const webMode = vi.hoisted(() => ({ value: true }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, on: vi.fn(() => () => {}), invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/utils/platform')>()),
  isWebMode: () => webMode.value,
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({
  CompanionSection: () => null,
}));

import { ChannelsSettings } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const accounts = [
  { id: 'a1', name: '账号一', type: 'http-api', status: 'connected', enabled: true, createdAt: 1, config: { type: 'http-api', port: 8080 } },
  { id: 'a2', name: '账号二', type: 'http-api', status: 'disconnected', enabled: true, createdAt: 2, config: { type: 'http-api', port: 8081 } },
];
const types = [{ type: 'http-api', name: 'HTTP API' }];

function mockList(list: unknown[]) {
  invoke.mockImplementation(async (channel: string) =>
    String(channel).toLowerCase().includes('types') ? types : list);
}

beforeEach(() => { webMode.value = true; });
afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); invoke.mockReset(); });

describe.each([['zh', zh], ['en', en]] as const)('ChannelsSettings web-mode note (%s)', (language, locale) => {
  const note = locale.settings.webModeBanner.channelsManageDesktopOnly;
  const c = locale.settings.channels;

  it('web: 5 类按钮禁用且带原因 title，可见句子出现', async () => {
    useAppStore.setState({ language });
    mockList(accounts);
    render(<ChannelsSettings />);
    await screen.findByText('账号一');
    expect(screen.getByText(note)).toBeTruthy();
    const buttons = [
      screen.getByRole('button', { name: new RegExp(c.modal.addTitle) }),
      ...screen.getAllByRole('button', { name: new RegExp(`^(${c.actions.connect}|${c.actions.disconnect}|${c.actions.edit}|${c.actions.delete})$`) }),
    ];
    expect(buttons).toHaveLength(1 + 2 * 3);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute('title')).toBe(note);
    }
  });

  it('web: 空列表时空态 Add 按钮同样带 title', async () => {
    useAppStore.setState({ language });
    mockList([]);
    render(<ChannelsSettings />);
    await screen.findByText(c.empty.description);
    const adds = screen.getAllByRole('button', { name: new RegExp(c.modal.addTitle) });
    expect(adds).toHaveLength(2);
    for (const b of adds) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute('title')).toBe(note);
    }
  });

  it('desktop: 按钮可用，无句子无 title', async () => {
    webMode.value = false;
    useAppStore.setState({ language });
    mockList(accounts);
    render(<ChannelsSettings />);
    await screen.findByText('账号一');
    expect(screen.queryByText(note)).toBeNull();
    const buttons = screen.getAllByRole('button', { name: new RegExp(`^(${c.actions.connect}|${c.actions.disconnect}|${c.actions.edit}|${c.actions.delete})$`) });
    expect(buttons.length).toBe(6);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
      expect(b.hasAttribute('title')).toBe(false);
    }
  });
});
