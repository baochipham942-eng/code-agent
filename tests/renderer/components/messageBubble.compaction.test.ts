// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => cleanup());

function makeMessage(): Message {
  return {
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
}

// B2-3 工程元数据收敛：折叠态只留消息数一句，tokens 数 + source/model/warnings/
// survivors 四个 pill 挪进展开态——这是接线钉子：折叠态不裸露，点开才看得到。
describe('MessageBubble compaction metadata', () => {
  it('折叠态只显示消息数摘要，tokens/pill 元数据不裸露', () => {
    render(React.createElement(MessageBubble, { message: makeMessage() }));

    expect(screen.getByText('已压缩 12 条消息')).toBeTruthy();
    expect(screen.queryByText(/3,456 tokens/)).toBeNull();
    expect(screen.queryByText('auto threshold')).toBeNull();
    expect(screen.queryByText('xiaomi/mimo-v2.5-pro')).toBeNull();
  });

  it('点击展开后显示 source/model/warnings/survivor manifest 元数据', () => {
    render(React.createElement(MessageBubble, { message: makeMessage() }));

    fireEvent.click(screen.getByText('已压缩 12 条消息'));

    expect(screen.getByText(/3,456 tokens/)).toBeTruthy();
    expect(screen.getByText('source')).toBeTruthy();
    expect(screen.getByText('auto threshold')).toBeTruthy();
    expect(screen.getByText('model')).toBeTruthy();
    expect(screen.getByText('xiaomi/mimo-v2.5-pro')).toBeTruthy();
    expect(screen.getByText('warnings')).toBeTruthy();
    expect(screen.getByText('survivors')).toBeTruthy();
    expect(screen.getByText('files 2')).toBeTruthy();
    expect(screen.getByText('errors 1')).toBeTruthy();
    expect(screen.getByText('open work 1')).toBeTruthy();
  });
});
