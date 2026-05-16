import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import {
  buildMultimodalContent,
  stripImagesFromMessages,
} from '../../../src/main/agent/messageHandling/converter';

describe('message attachment conversion', () => {
  it('keeps an image analysis path hint when vision content is stripped', () => {
    const attachment: MessageAttachment = {
      id: 'att-1',
      type: 'image',
      category: 'image',
      name: 'screen.png',
      size: 128,
      mimeType: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
      path: '/tmp/screen.png',
    };

    const content = buildMultimodalContent('看看这个', [attachment]);
    const imageHint = content.find((part) =>
      part.type === 'text' && part.text?.includes('image_analyze')
    );

    expect(content.some((part) => part.type === 'image')).toBe(true);
    expect(imageHint?.text).toContain('image_analyze');
    expect(imageHint?.text).toContain('/tmp/screen.png');

    const stripped = stripImagesFromMessages([{ role: 'user', content }]);

    expect(JSON.stringify(stripped[0].content)).toContain('image_analyze');
    expect(JSON.stringify(stripped[0].content)).toContain('/tmp/screen.png');
    expect(JSON.stringify(stripped[0].content)).toContain('不要回答“没有收到图片”');
  });
});
