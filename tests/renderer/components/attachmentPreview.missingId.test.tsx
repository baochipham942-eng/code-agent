import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import type { MessageAttachment } from '../../../src/shared/contract/message';

// 同源问题参见 tests/unit/agent/messageConverter.attachments.test.ts 的「missing its id」用例：
// sanitizeAttachmentForPersistence 透传 attachment.id，脏数据落库后 id 可能是 undefined，
// 类型标注为必填 string 但运行时不保证。AttachmentPreview.tsx 里 `displayAttachment.id.startsWith(...)`
// / `.replace(...)` 的裸访问会在渲染这类历史附件时抛 TypeError，必须改走 getAttachmentId()。
describe('AttachmentDisplay 渲染缺 id 的历史附件', () => {
  it('图片附件缺 id 时不抛出，且不误判为 appshot', () => {
    const attachmentMissingId = {
      type: 'image',
      category: 'image',
      name: 'legacy-import.png',
      size: 128,
      mimeType: 'image/png',
      path: '/tmp/legacy-import.png',
      // id 字段缺失 —— 类型标注为必填 string，但运行时数据不保证遵守。
    } as unknown as MessageAttachment;

    expect(() =>
      renderToStaticMarkup(<AttachmentDisplay attachments={[attachmentMissingId]} />),
    ).not.toThrow();

    const html = renderToStaticMarkup(<AttachmentDisplay attachments={[attachmentMissingId]} />);
    expect(html).toContain('legacy-import.png');
  });
});
