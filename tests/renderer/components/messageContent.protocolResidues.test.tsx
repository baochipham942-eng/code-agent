import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { filterSystemTags } from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';

describe('MessageContent protocol residue filtering', () => {
  it('removes LongCat tool tags without dropping the readable assistant summary', () => {
    const content = [
      '<longcat_tool_call><longcat_arg_key>command</longcat_arg_key><longcat_arg_value>{"command":"pwd"}</longcat_arg_value></longcat_tool_call>',
      '',
      '已完成检查，工作目录状态正常。',
    ].join('\n');

    expect(filterSystemTags(content)).toBe('已完成检查，工作目录状态正常。');
    const html = renderToStaticMarkup(<MessageContent content={content} isUser={false} />);
    expect(html).toContain('已完成检查，工作目录状态正常。');
    expect(html).not.toContain('longcat_');
  });
});
