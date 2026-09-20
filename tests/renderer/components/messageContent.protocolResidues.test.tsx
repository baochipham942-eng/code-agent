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

  it('strips an unclosed LongCat tool block through the end of the string', () => {
    const content = [
      '先看目录',
      '<longcat_tool_call><longcat_arg_key>command</longcat_arg_key><longcat_arg_value>{"command":"pwd"}',
    ].join('\n');

    expect(filterSystemTags(content)).toBe('先看目录');
    const html = renderToStaticMarkup(<MessageContent content={content} isUser={false} />);
    expect(html).toContain('先看目录');
    expect(html).not.toContain('longcat_');
    expect(html).not.toContain('{"command":"pwd"}');
  });

  it('strips a stray LongCat closing tag', () => {
    const content = '检查完成。</longcat_tool_call>';

    expect(filterSystemTags(content)).toBe('检查完成。');
    const html = renderToStaticMarkup(<MessageContent content={content} isUser={false} />);
    expect(html).toContain('检查完成。');
    expect(html).not.toContain('longcat_');
  });

  it('strips unwrapped LongCat arg_key/arg_value residue', () => {
    const content = [
      '<longcat_arg_key>command</longcat_arg_key><longcat_arg_value>{"command":"pwd"}</longcat_arg_value>',
      '',
      '目录正常。',
    ].join('\n');

    expect(filterSystemTags(content)).toBe('目录正常。');
    const html = renderToStaticMarkup(<MessageContent content={content} isUser={false} />);
    expect(html).toContain('目录正常。');
    expect(html).not.toContain('longcat_');
    expect(html).not.toContain('{"command":"pwd"}');
  });

  it('does not strip LongCat markup from user messages', () => {
    const content = [
      '<longcat_tool_call><longcat_arg_key>command</longcat_arg_key><longcat_arg_value>{"command":"pwd"}</longcat_arg_value></longcat_tool_call>',
      '请保留这段用户原文',
    ].join('\n');

    const html = renderToStaticMarkup(<MessageContent content={content} isUser />);
    expect(html).toContain('longcat_tool_call');
    expect(html).toContain('longcat_arg_key');
    expect(html).toContain('longcat_arg_value');
    expect(html).toContain('&quot;command&quot;:&quot;pwd&quot;');
    expect(html).toContain('请保留这段用户原文');
  });
});
