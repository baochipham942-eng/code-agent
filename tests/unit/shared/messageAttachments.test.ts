import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import {
  sanitizeAttachmentForPersistence,
  stripInlineAttachmentBlocks,
} from '../../../src/shared/utils/messageAttachments';

describe('message attachment persistence helpers', () => {
  it('keeps presentation summaries while dropping inline binary data', () => {
    const attachment: MessageAttachment = {
      id: 'ppt-1',
      type: 'file',
      category: 'presentation',
      name: 'deck.pptx',
      size: 1024,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: 'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,AAAAPPT',
      path: '/tmp/deck.pptx',
      pptJson: '{"slideCount":6}',
    };

    const stored = sanitizeAttachmentForPersistence(attachment);

    expect(stored.data).toBeUndefined();
    expect(stored.path).toBe('/tmp/deck.pptx');
    expect(stored.pptJson).toBe('{"slideCount":6}');
  });

  it('strips legacy inline attachment blocks from visible message text', () => {
    const content = [
      '请看附件',
      '<attachment name="bundle.zip" category="archive">',
      'data:application/zip;base64,AAAAZIP',
      '</attachment>',
    ].join('\n');

    expect(stripInlineAttachmentBlocks(content)).toBe('请看附件');
  });

  it('keeps appshot thumbnails without persisting local screenshot paths', () => {
    const attachment: MessageAttachment = {
      id: 'appshot-appshot-1',
      type: 'image',
      category: 'image',
      name: 'Finder.png',
      size: 128,
      mimeType: 'image/png',
      data: 'data:image/png;base64,full',
      thumbnail: 'data:image/png;base64,thumb',
      path: '/Users/linchen/.code-agent/appshots/appshot-1.png',
    };

    const stored = sanitizeAttachmentForPersistence(attachment);

    expect(stored.data).toBeUndefined();
    expect(stored.path).toBeUndefined();
    expect(stored.thumbnail).toBe('data:image/png;base64,thumb');
  });
});
