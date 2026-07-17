// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const invoke = vi.hoisted(() => vi.fn());

// 静态渲染下 effect 不跑（checkpoints 维持空），mock store + ipcService 让模块可导入。
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: () => ({ currentSessionId: 'sess-1' }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke },
}));

import { RewindPanel } from '../../../src/renderer/components/RewindPanel';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
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
    expect(html).toContain('回退到检查点');
    expect(html).toContain('暂无可用检查点');
    expect(html).toContain('取消');
    expect(html).toContain('回退');
  });

  it('puts checkpoint rows in the Tab order and previews on Enter', async () => {
    invoke
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
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.CHECKPOINT_PREVIEW,
        'sess-1',
        'message-1',
      );
    });
    expect(checkpoint.getAttribute('aria-pressed')).toBe('true');
  });

  it('confirms the final rewind without interrupting checkpoint selection', async () => {
    invoke
      .mockResolvedValueOnce([
        { id: 'checkpoint-1', messageId: 'message-1', timestamp: 1, description: 'Before edit', fileCount: 1 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ success: true, filesRestored: 1 });
    const onClose = vi.fn();
    render(<RewindPanel isOpen={true} onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /Before edit/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '回退' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    expect(invoke).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '取消回退' }));
    expect(invoke).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '回退' }));
    fireEvent.click(screen.getByRole('button', { name: '确认回退' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.CHECKPOINT_REWIND,
        'sess-1',
        'message-1',
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows rewind failures inside the panel and leaves retry available', async () => {
    invoke
      .mockResolvedValueOnce([
        { id: 'checkpoint-1', messageId: 'message-1', timestamp: 1, description: 'Before edit', fileCount: 1 },
      ])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('workspace locked'));
    const onClose = vi.fn();
    render(<RewindPanel isOpen={true} onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: /Before edit/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '回退' }));
    fireEvent.click(screen.getByRole('button', { name: '确认回退' }));

    expect(await screen.findByText(/workspace locked/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '回退' }).getAttribute('disabled')).toBeNull();
  });
});
