import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import {
  AttachmentDisplay,
  getAttachmentMediaState,
} from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';

describe('MessageBubble media and channel affordances', () => {
  it('normalizes attachment media lifecycle states', () => {
    expect(getAttachmentMediaState({ id: 'a1', name: 'voice.wav', type: 'file', category: 'audio', size: 1, mimeType: 'audio/wav', mediaState: 'transcribing' } as MessageAttachment))
      .toMatchObject({ label: '转写中', tone: 'active', spinning: true });
    expect(getAttachmentMediaState({
      id: 'a2',
      name: 'photo.png',
      type: 'image',
      size: 1,
      metadata: { materializationState: 'failed' },
    } as MessageAttachment)).toMatchObject({ label: '处理失败', tone: 'danger' });
  });

  it('renders visible attachment status badges', () => {
    const html = renderToStaticMarkup(
      React.createElement(AttachmentDisplay, {
        attachments: [
          {
            id: 'voice-1',
            name: 'voice.wav',
            type: 'file',
            category: 'audio',
            path: '/tmp/voice.wav',
            size: 1024,
            mediaState: 'transcribing',
          },
        ] satisfies MessageAttachment[],
      }),
    );

    expect(html).toContain('voice.wav');
    expect(html).toContain('转写中');
  });

  it('renders retry affordance for failed channel media attachments', () => {
    const html = renderToStaticMarkup(
      React.createElement(AttachmentDisplay, {
        attachments: [
          {
            id: 'img-1',
            name: 'photo.png',
            type: 'image',
            category: 'image',
            path: '/tmp/photo.png',
            size: 1024,
            mediaState: 'failed',
            metadata: {
              accountId: 'feishu-account',
              messageId: 'om_1',
              resourceType: 'image',
              platformFileKey: 'img_1',
            },
          },
        ] satisfies MessageAttachment[],
      }),
    );

    expect(html).toContain('处理失败');
    expect(html).toContain('重试');
  });
});
