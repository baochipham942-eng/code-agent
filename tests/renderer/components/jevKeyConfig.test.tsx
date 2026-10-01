// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomainMock = vi.hoisted(() => vi.fn());
const storedKeys = vi.hoisted(() => ({
  current: {} as Record<string, string>,
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomainMock(...args) },
}));

import { JevKeyConfig } from '../../../src/renderer/components/features/settings/tabs/JevKeyConfig';

describe('JevKeyConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedKeys.current = {};
    invokeDomainMock.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'getAllServiceKeys') return storedKeys.current;
      return undefined;
    });
  });
  afterEach(() => cleanup());

  it('保存调用 setServiceApiKey，service 为 typesafe，保存后只显示打码', async () => {
    render(<JevKeyConfig />);
    const input = await screen.findByTestId('jev-key-input');
    expect((screen.getByTestId('jev-key-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'ts-live-secret-value' } });
    fireEvent.click(screen.getByTestId('jev-key-save'));

    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'typesafe', apiKey: 'ts-live-secret-value' },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('jev-key-masked').textContent).toBe('ts-live-...');
    });
    expect(screen.queryByTestId('jev-key-input')).toBeNull();
    expect(screen.getByTestId('jev-api-key-description').textContent).toBe(zh.settings.general.jevKey.description);
  });

  it('已配置的 key 上空保存先要确认，确认后才写空串清除', async () => {
    storedKeys.current = { typesafe: 'ts-key12...' };
    render(<JevKeyConfig />);

    expect(await screen.findByTestId('jev-key-masked')).toBeTruthy();
    expect(screen.getByTestId('jev-key-masked').textContent).toBe('ts-key12...');
    fireEvent.click(screen.getByTestId('jev-key-change'));
    fireEvent.click(screen.getByTestId('jev-key-save'));

    expect(await screen.findByText(zh.settings.general.jevKey.clearTitle)).toBeTruthy();
    expect(invokeDomainMock).not.toHaveBeenCalledWith(
      IPC_DOMAINS.SETTINGS,
      'setServiceApiKey',
      expect.anything(),
    );

    fireEvent.click(screen.getByText(zh.settings.general.jevKey.clearConfirm));
    await waitFor(() => {
      expect(invokeDomainMock).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'setServiceApiKey',
        { service: 'typesafe', apiKey: '' },
      );
    });
  });
});
