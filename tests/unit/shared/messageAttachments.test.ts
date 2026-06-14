import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import {
  collectAttachmentPersistenceMetrics,
  sanitizeAttachmentForPersistence,
  sanitizeAttachmentsForPersistence,
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

  it('drops large image data urls from persisted attachments while preserving the file path', () => {
    const largeDataUrl = `data:image/png;base64,${'A'.repeat(600 * 1024)}`;
    const attachment: MessageAttachment = {
      id: 'image-large-1',
      type: 'image',
      category: 'image',
      name: 'large.png',
      size: 10 * 1024 * 1024,
      mimeType: 'image/png',
      data: largeDataUrl,
      path: '/tmp/large.png',
    };

    const stored = sanitizeAttachmentForPersistence(attachment);

    expect(stored.data).toBeUndefined();
    expect(stored.thumbnail).toBeUndefined();
    expect(stored.path).toBe('/tmp/large.png');
  });

  it('drops large audio data urls from persisted attachments while preserving media state', () => {
    const attachment: MessageAttachment = {
      id: 'voice-large-1',
      type: 'file',
      category: 'audio',
      name: 'voice.wav',
      size: 10 * 1024 * 1024,
      mimeType: 'audio/wav',
      data: `data:audio/wav;base64,${'A'.repeat(600 * 1024)}`,
      path: '/tmp/voice.wav',
      mediaState: 'ready',
    };

    const stored = sanitizeAttachmentForPersistence(attachment);

    expect(stored.data).toBeUndefined();
    expect(stored.path).toBe('/tmp/voice.wav');
    expect(stored.mediaState).toBe('ready');
  });

  it('reports data-url persistence metrics after sanitizing attachments', () => {
    const largeDataUrl = `data:image/png;base64,${'A'.repeat(600 * 1024)}`;
    const smallDataUrl = 'data:image/png;base64,small';
    const attachments: MessageAttachment[] = [
      {
        id: 'large',
        type: 'image',
        category: 'image',
        name: 'large.png',
        size: 1024,
        mimeType: 'image/png',
        data: largeDataUrl,
        path: '/tmp/large.png',
      },
      {
        id: 'small',
        type: 'image',
        category: 'image',
        name: 'small.png',
        size: 32,
        mimeType: 'image/png',
        data: smallDataUrl,
      },
    ];

    const persisted = sanitizeAttachmentsForPersistence(attachments);
    const metrics = collectAttachmentPersistenceMetrics(attachments, persisted);

    expect(metrics.attachmentCount).toBe(2);
    expect(metrics.originalDataUrlCount).toBe(2);
    expect(metrics.persistedDataUrlCount).toBe(1);
    expect(metrics.strippedDataUrlCount).toBe(1);
    expect(metrics.strippedDataUrlChars).toBeGreaterThan(500 * 1024);
  });
});
