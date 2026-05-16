import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HandoffProposal } from '../../../src/shared/contract/handoff';

const sessionState = {
  currentSessionId: 'session-1',
  messages: [{ id: 'm1' }],
};

const handoffItem: HandoffProposal = {
  id: 'handoff:session-1:assistant-1',
  sessionId: 'session-1',
  sourceMessageId: 'assistant-1',
  source: 'assistant_tail',
  status: 'pending',
  title: '继续验证安装包',
  prompt: '继续验证刚才生成的安装包。',
  reason: '安装验证还没有跑。',
  createdAt: 100,
  updatedAt: 100,
};

const handoffState = {
  items: [handoffItem],
  load: vi.fn(),
  updateStatus: vi.fn(),
};

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));

vi.mock('../../../src/renderer/stores/handoffStore', () => ({
  useHandoffStore: (selector: (state: typeof handoffState) => unknown) => selector(handoffState),
}));

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: { sendPrompt: (content: string) => Promise<void> }) => unknown) =>
    selector({ sendPrompt: vi.fn(async () => undefined) }),
}));

import { HandoffCard } from '../../../src/renderer/components/TaskPanel/HandoffCard';

describe('HandoffCard', () => {
  it('renders a compact pending handoff proposal', () => {
    const html = renderToStaticMarkup(React.createElement(HandoffCard));

    expect(html).toContain('Handoff');
    expect(html).toContain('继续验证安装包');
    expect(html).toContain('安装验证还没有跑。');
    expect(html).toContain('aria-label="继续 继续验证安装包"');
    expect(html).toContain('aria-label="忽略 继续验证安装包"');
  });
});
