// @vitest-environment jsdom
// N-ATTACH-PREVIEW-403：会话内图片附件经 /api/workspace/file 加载失败（如 403）时，
// 不许裸奔浏览器破图——给「无法预览」说明 + 重试按钮；重试加 cache-busting 重新拉取。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
