// ============================================================================
// stripToolCallProtocolMarkup — 输出侧兜底：剥离助手正文里的工具调用协议裸标记
// （issue #1991：LongCat 在禁工具推理轮回落到 <longcat_tool_call> 裸文本协议，
//  泄漏进最终回复怼到用户脸上）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { stripInternalFormatMimicry } from '../../../src/host/agent/runtime/contextAssembly/transcriptProjection';

// 生产侧唯一消费点是 stripInternalFormatMimicry（knip 生产档不允许只被测试引用的导出），
// 单测走同一入口，顺带覆盖接线。
const stripToolCallProtocolMarkup = (content: string): string =>
  stripInternalFormatMimicry(null as never, content);

describe('stripToolCallProtocolMarkup', () => {
  it('returns non-markup text unchanged', () => {
    const text = '基于已读取的文件，结论是：配置在 package.json 里。';
    expect(stripToolCallProtocolMarkup(text)).toBe(text);
  });

  it('returns empty-ish input unchanged', () => {
    expect(stripToolCallProtocolMarkup('')).toBe('');
  });

  it('strips a complete <longcat_tool_call> block and keeps surrounding prose', () => {
    const input = [
      '先给出结论。',
      '<longcat_tool_call>{"name": "Glob", "arguments": {"pattern": "**/*.ts"}}</longcat_tool_call>',
      '以上是已经拿到的证据。',
    ].join('\n');
    const cleaned = stripToolCallProtocolMarkup(input);
    expect(cleaned).toContain('先给出结论。');
    expect(cleaned).toContain('以上是已经拿到的证据。');
    expect(cleaned).not.toContain('longcat_tool_call');
    expect(cleaned).not.toContain('Glob');
  });

  it('strips an unclosed <longcat_tool_call> through end of string', () => {
    const input = '结论如下。\n<longcat_tool_call>{"name": "Read", "arguments": {"file_path": "/tmp/a.ts"}}';
    const cleaned = stripToolCallProtocolMarkup(input);
    expect(cleaned).toBe('结论如下。');
  });

  it('strips <longcat_tool_call> carrying arg_key/arg_value fragments', () => {
    const input = [
      '<longcat_tool_call>',
      '<longcat_arg_key>command</longcat_arg_key>',
      '<longcat_arg_value>cat evidence.txt</longcat_arg_value>',
      '</longcat_tool_call>',
      '正文保留。',
    ].join('\n');
    const cleaned = stripToolCallProtocolMarkup(input);
    expect(cleaned).toBe('正文保留。');
  });

  it('strips stray arg_key/arg_value fragments without the wrapper', () => {
    const input = '残片开头 <longcat_arg_key>command</longcat_arg_key> 残片结尾';
    const cleaned = stripToolCallProtocolMarkup(input);
    expect(cleaned).not.toContain('longcat_arg_key');
    expect(cleaned).not.toContain('command');
    expect(cleaned).toContain('残片开头');
    expect(cleaned).toContain('残片结尾');
  });

  it('strips lone opening/closing longcat tags', () => {
    const input = 'a </longcat_tool_call> b <longcat_arg_value> c';
    const cleaned = stripToolCallProtocolMarkup(input);
    expect(cleaned).not.toContain('longcat_');
    expect(cleaned).toContain('a');
    expect(cleaned).toContain('b');
  });

  it('strips multiple call blocks in one response', () => {
    const input = [
      '<longcat_tool_call>{"name": "Read", "arguments": {}}</longcat_tool_call>',
      '中间文本',
      '<longcat_tool_call>{"name": "Glob", "arguments": {}}</longcat_tool_call>',
    ].join('\n');
    const cleaned = stripToolCallProtocolMarkup(input);
    expect(cleaned).toBe('中间文本');
  });

  it('does not touch unrelated angle-bracket text', () => {
    const text = '类型写作 Array<string>，比较是 a < b。';
    expect(stripToolCallProtocolMarkup(text)).toBe(text);
  });
});
