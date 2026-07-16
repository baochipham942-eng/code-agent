// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '../../../src/shared/contract';

const updateEvent = vi.hoisted(() => ({ handler: null as null | ((event: unknown) => void) }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: vi.fn((_channel: string, handler: (event: unknown) => void) => {
      updateEvent.handler = handler;
      return vi.fn();
    }),
  },
}));

import { UpdateNotification } from '../../../src/renderer/components/UpdateNotification';

const updateInfo = {
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  releaseNotes: '修复若干问题',
  downloadUrl: 'https://example.com/app.dmg',
  fileSize: 1024 * 1024,
} as unknown as UpdateInfo;

// 验证 UpdateNotification 从手搓 backdrop+容器弹窗迁移到 Modal primitive 后行为不回归
describe('UpdateNotification (Modal primitive 迁移验证)', () => {
  beforeEach(() => {
    updateEvent.handler = null;
  });

  afterEach(cleanup);

  it('idle 态：走 Modal primitive（role=dialog + aria-modal），标题/更新内容/footer 齐全', () => {
    const html = renderToStaticMarkup(
      <UpdateNotification updateInfo={updateInfo} onClose={() => {}} />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('软件更新');
    expect(html).toContain('发现新版本可用');
    expect(html).toContain('更新内容');
    // footer 动作（idle 态）
    expect(html).toContain('取消');
    expect(html).toContain('立即下载');
  });

  it('打开已下载安装包失败时进入现有错误 UI 并显示原因', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('无法打开安装包'));
    Object.defineProperty(window, 'domainAPI', {
      configurable: true,
      value: { invoke },
    });
    render(<UpdateNotification updateInfo={updateInfo} onClose={() => {}} />);
    act(() => {
      updateEvent.handler?.({ type: 'download_complete', data: { filePath: '/tmp/update.dmg' } });
    });

    fireEvent.click(screen.getByText('立即安装'));

    await waitFor(() => expect(screen.getByText('无法打开安装包')).toBeTruthy());
    expect(screen.getByText('下载失败')).toBeTruthy();
  });
});
