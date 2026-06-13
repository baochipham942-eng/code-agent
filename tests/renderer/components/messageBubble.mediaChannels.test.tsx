import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message, MessageAttachment } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: unknown) => unknown) =>
    selector({
      editMessage: vi.fn(),
      regenerateMessage: vi.fn(),
      forkFromHere: vi.fn(),
    }),
}));

import { MessageBubble } from '../../../src/renderer/components/features/chat/MessageBubble';
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

  it('renders channel source on user messages from external channels', () => {
    const message: Message = {
      id: 'channel-user-1',
      role: 'user',
      content: '帮我看这张图',
      timestamp: 1,
      metadata: {
        channel: {
          platform: 'lark',
          accountId: 'lark-global',
          accountName: 'Global Bot',
          chatId: 'oc_demo',
          chatName: 'Customer Ops',
          messageId: 'om_demo',
        },
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, { message }),
    );

    expect(html).toContain('Lark · Global Bot · Customer Ops');
    expect(html).toContain('帮我看这张图');
  });
});
