import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: unknown) => unknown) =>
    selector({
      editMessage: vi.fn(),
      regenerateMessage: vi.fn(),
      forkFromHere: vi.fn(),
    }),
}));

import { MessageBubble } from '../../../src/renderer/components/features/chat/MessageBubble';

describe('MessageBubble compaction metadata', () => {
  it('renders compact source, model, warning, and survivor manifest metadata', () => {
    const message: Message = {
      id: 'compact-1',
      role: 'system',
      content: 'summary',
      timestamp: 1,
      compaction: {
        type: 'compaction',
        content: 'handoff summary',
        timestamp: 1,
        compactedMessageCount: 12,
        compactedTokenCount: 3456,
        source: 'auto_threshold',
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        warnings: ['summary missed one open item'],
        survivorManifest: {
          files: [
            { path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/autoCompressor.ts' },
            { path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/compactionService.ts' },
          ],
          errors: [
            { label: 'Unresolved error', detail: 'vitest failed', severity: 'error' },
          ],
          openWork: [
            { label: 'Open work', detail: 'rerun component test', severity: 'warning' },
          ],
        },
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, { message }),
    );

    expect(html).toContain('已压缩 12 条消息');
    expect(html).toContain('3,456 tokens');
    expect(html).toContain('source');
    expect(html).toContain('auto threshold');
    expect(html).toContain('model');
    expect(html).toContain('xiaomi/mimo-v2.5-pro');
    expect(html).toContain('warnings');
    expect(html).toContain('survivors');
    expect(html).toContain('files 2');
    expect(html).toContain('errors 1');
    expect(html).toContain('open 1');
  });
});
