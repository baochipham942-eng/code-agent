// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeDomain: vi.fn(),
}));

// 静态渲染下 effect 不跑（checkpoints 维持空），mock store + ipcService 让模块可导入。
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({ currentSessionId: 'sess-1' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: mocks.invoke,
    invokeDomain: mocks.invokeDomain,
  },
}));

import { RewindPanel } from '../../../src/renderer/components/RewindPanel';

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue([]);
  mocks.invokeDomain.mockReset();
  mocks.invokeDomain.mockResolvedValue({
    success: true,
    restoredFileCount: 1,
    deletedFileCount: 0,
    workspaceChanged: true,
    conversationChanged: false,
  });
});

afterEach(cleanup);

// 验证 RewindPanel 从手搓 fixed-inset-0 弹窗迁移到 Modal primitive 后行为不回归
describe('RewindPanel (Modal primitive 迁移验证)', () => {
  it('关闭态：不渲染任何弹窗', () => {
    const html = renderToStaticMarkup(<RewindPanel isOpen={false} onClose={() => {}} />);
    expect(html).toBe('');
  });

  it('开启态：走 Modal primitive（role=dialog + aria-modal），标题/空态/footer 齐全', () => {
    const html = renderToStaticMarkup(<RewindPanel isOpen={true} onClose={() => {}} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('恢复工作区文件');
    expect(html).toContain('暂无可用检查点');
    expect(html).toContain('取消');
    expect(html).toContain('恢复文件');
  });

  it('puts checkpoint rows in the Tab order and previews on Enter', async () => {
    mocks.invoke
      .mockResolvedValueOnce([
        {
          id: 'checkpoint-1',
          messageId: 'message-1',
          timestamp: 1,
          description: 'Before edit',
          fileCount: 1,
        },
      ])
      .mockResolvedValueOnce([]);
    const { findByRole } = render(<RewindPanel isOpen={true} onClose={() => {}} />);
    const checkpoint = await findByRole('button', { name: /Before edit/ });

    expect(checkpoint.getAttribute('type')).toBe('button');
    expect(checkpoint.getAttribute('aria-pressed')).toBe('false');
    checkpoint.focus();
    fireEvent.keyDown(checkpoint, { key: 'Enter' });

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.CHECKPOINT_PREVIEW,
        'sess-1',
        'message-1',
      );
    });
    expect(checkpoint.getAttribute('aria-pressed')).toBe('true');
  });

  it('confirms the final rewind without interrupting checkpoint selection', async () => {
    mocks.invoke
      .mockResolvedValueOnce([
        { id: 'checkpoint-1', messageId: 'message-1', timestamp: 1, description: 'Before edit', fileCount: 1 },
      ])
      .mockResolvedValueOnce([]);
    const onClose = vi.fn();
    render(<RewindPanel isOpen={true} onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /Before edit/ }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '恢复文件' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    expect(mocks.invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消恢复' }));
    expect(mocks.invokeDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '恢复文件' }));
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));
    await waitFor(() => {
      expect(mocks.invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SESSION,
        'restoreWorkspaceFilesAtCheckpoint',
        {
          sessionId: 'sess-1',
          checkpointMessageId: 'message-1',
        },
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC_CHANNELS.CHECKPOINT_REWIND,
      expect.anything(),
      expect.anything(),
    );
  });

  it('shows rewind failures inside the panel and leaves retry available', async () => {
    mocks.invoke
      .mockResolvedValueOnce([
        { id: 'checkpoint-1', messageId: 'message-1', timestamp: 1, description: 'Before edit', fileCount: 1 },
      ])
      .mockResolvedValueOnce([]);
    mocks.invokeDomain.mockRejectedValueOnce(new Error('workspace locked'));
    const onClose = vi.fn();
    render(<RewindPanel isOpen={true} onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /Before edit/ }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '恢复文件' }));
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));

    expect(await screen.findByText(/workspace locked/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '恢复文件' }).getAttribute('disabled')).toBeNull();
  });
});
