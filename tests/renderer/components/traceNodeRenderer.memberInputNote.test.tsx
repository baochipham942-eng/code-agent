// @vitest-environment jsdom
// N-SUBAGENT-INPUT：主对话里的折叠记录渲染成一行「你给 {name} 补了一句：…」，不走助手气泡。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => content,
}));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index', () => ({ ToolCallDisplay: () => null }));
vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({ AttachmentDisplay: () => null }));
vi.mock('../../../src/renderer/components/features/chat/ExpandableContent', () => ({ ExpandableContent: () => null }));

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

describe('TraceNodeRenderer · member input note', () => {
  it.each([
    ['supplement', zh.expert.memberBar.mainRecordSupplement],
    ['redirect', zh.expert.memberBar.mainRecordRedirect],
  ] as const)('renders the %s record as one folded line', (mode, label) => {
    const node: TraceNode = {
      id: 'steer-1-member-input', messageId: 'steer-1', type: 'assistant_text', content: '顺便把页码加上', timestamp: 110,
      metadata: { memberInput: { memberId: 'task-7', memberName: '报告任务', mode } },
    };
    const html = renderToStaticMarkup(React.createElement(TraceNodeRenderer, { node }));
    expect(html).toContain('data-testid="member-input-note"');
    expect(html).toContain(`${label.replace('{name}', '报告任务')}：顺便把页码加上`);
  });
});
