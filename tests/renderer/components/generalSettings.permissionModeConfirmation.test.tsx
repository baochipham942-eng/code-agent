// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain },
}));

import { GeneralSettings } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';

beforeEach(() => {
  invoke.mockReset();
  invokeDomain.mockReset();
  invoke.mockImplementation(async (channel: string) =>
    channel === IPC_CHANNELS.PERMISSION_GET_MODE ? 'default' : true,
  );
  invokeDomain.mockResolvedValue({ permissions: {} });
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

function switchButtonFor(modeName: string): HTMLButtonElement {
  const row = screen.getByText(modeName).closest('tr');
  const button = row?.querySelector('button');
  if (!button) throw new Error(`Missing switch button for ${modeName}`);
  return button;
}

describe('GeneralSettings permission mode confirmation', () => {
  it('sets the high-risk bypassPermissions mode only after explicit confirmation', async () => {
    render(<GeneralSettings />);
    await screen.findByText('YOLO 模式');
    invoke.mockClear();

    fireEvent.click(switchButtonFor('YOLO 模式'));

    expect(screen.getByRole('dialog').textContent).toContain(
      '权限检查已跳过。Agent 可以直接执行文件写入、命令执行等操作，请只在可信隔离环境中使用。',
    );
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(switchButtonFor('YOLO 模式'));
    fireEvent.click(screen.getByRole('button', { name: '启用 YOLO 模式' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.PERMISSION_SET_MODE,
        'bypassPermissions',
      );
    });
  });

  it('keeps low- and medium-risk mode switches immediate', async () => {
    render(<GeneralSettings />);
    await screen.findByText('只读探索');
    invoke.mockClear();

    fireEvent.click(switchButtonFor('只读探索'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.PERMISSION_SET_MODE, 'readOnly');
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(switchButtonFor('自动编辑'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.PERMISSION_SET_MODE, 'acceptEdits');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
