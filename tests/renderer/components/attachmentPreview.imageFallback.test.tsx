// @vitest-environment jsdom
// N-ATTACH-PREVIEW-403：会话内图片附件经 /api/workspace/file 加载失败（如 403）时，
// 不许裸奔浏览器破图——给「无法预览」说明 + 重试按钮；重试加 cache-busting 重新拉取。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/ipcService')>();
  return { ...actual, default: { ...actual.default, invoke } };
});

import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import type { MessageAttachment } from '../../../src/shared/contract/message';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const brokenImage: MessageAttachment = {
  id: 'att-broken-1',
  type: 'image',
  category: 'image',
  name: '截图-报错.png',
  size: 69,
  mimeType: 'image/png',
  path: '/ws/cw-edge-image/资料/截图-报错.png',
} as MessageAttachment;

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});

afterEach(cleanup);

describe('AttachmentDisplay 图片加载失败兜底（N-ATTACH-PREVIEW-403）', () => {
  it('img onError 后显示「无法预览」与重试，点重试重新渲染 img 并加 cache-busting', () => {
    const { container } = render(<AttachmentDisplay attachments={[brokenImage]} />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.src).toContain('/api/workspace/file');

    fireEvent.error(img!);
    expect(screen.getByText('无法预览此图片')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    const retriedImg = container.querySelector('img');
    expect(retriedImg).not.toBeNull();
    expect(retriedImg!.src).toContain('_r=1');
  });

  // ai-review PR#2030 Important：渠道媒体重试成功更新 displayAttachment 后，
  // 必须清掉 imageLoadFailed 占位，否则恢复的图片仍被「无法预览」挡住。
  it('渠道媒体重试成功后清除失败占位，恢复后的图片重新渲染', async () => {
    const channelImage = {
      ...brokenImage,
      id: 'att-channel-1',
      mediaState: 'failed',
      metadata: { accountId: 'acc-1', platformFileKey: 'pfk-1' },
    } as MessageAttachment;
    invoke.mockResolvedValue({
      success: true,
      attachment: {
        id: 'att-channel-1',
        type: 'image',
        name: '截图-报错.png',
        mimeType: 'image/png',
        size: 69,
        localPath: '/ws/cw-edge-image/资料/截图-报错.png',
        mediaState: 'ready',
        metadata: { accountId: 'acc-1' },
      },
    });

    const { container } = render(<AttachmentDisplay attachments={[channelImage]} />);
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByText('无法预览此图片')).toBeTruthy();

    // 「处理失败」徽标里的重试（渠道路径），与兜底卡上的重试区分开
    const badge = screen.getByText('处理失败').closest('span')!;
    fireEvent.click(badge.querySelector('button')!);

    await waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });
    expect(container.querySelector('img')!.src).toContain('_r=1');
    expect(screen.queryByText('无法预览此图片')).toBeNull();
  });
});
