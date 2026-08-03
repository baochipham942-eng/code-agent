// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const openHttpLinkInRail = vi.fn(() => true);
const openExternalLink = vi.fn(() => true);

vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  openHttpLinkInRail,
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
  copyPathToClipboard: vi.fn(),
  openExternalLink,
}));

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

async function clickRenderedLink(content: string) {
  const view = render(
    <MessageContent
      content={content}
      isUser={false}
      messageId="assistant-1"
      mediaContext={{ sessionId: 'conversation-a' }}
    />,
  );
  await waitFor(() => expect(view.container.querySelector('a')).toBeTruthy());
  fireEvent.click(view.container.querySelector('a') as HTMLAnchorElement);
}

describe('MessageContent browser rail link wiring', () => {
  beforeEach(() => {
    openHttpLinkInRail.mockClear();
    openExternalLink.mockClear();
    useAppStore.setState({ workingDirectory: '/tmp/browser-rail-workspace' });
  });

  afterEach(() => cleanup());

  it('routes described and raw http(s) links into the browser rail, not workspace.openExternal', async () => {
    await clickRenderedLink('[Example](https://example.test/path)');
    await clickRenderedLink('https://example.test/raw');

    expect(openHttpLinkInRail).toHaveBeenNthCalledWith(1, {
      href: 'https://example.test/path',
      conversationId: 'conversation-a',
      workspace: '/tmp/browser-rail-workspace',
    });
    expect(openHttpLinkInRail).toHaveBeenNthCalledWith(2, {
      href: 'https://example.test/raw',
      conversationId: 'conversation-a',
      workspace: '/tmp/browser-rail-workspace',
    });
    expect(openExternalLink).not.toHaveBeenCalled();
  });
});
