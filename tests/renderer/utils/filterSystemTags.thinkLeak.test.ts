import { describe, expect, it } from 'vitest';
import { filterSystemTags } from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';

// 真实事故：流式响应异常截断（命中 length / 连接中断）时 <think> 可能没等到闭合标签。
// 宿主层 sseStream.ts 已经把这类未闭合推理挪进 thinking 字段，这里是渲染层兜底——
// 防历史脏数据或未知泄漏路径把整段推理原文摊在正文里，绕过思考折叠机制。
describe('filterSystemTags — 未闭合 <think> 兜底', () => {
  it('剥离完整闭合的 think 块（既有行为不变）', () => {
    expect(filterSystemTags('<think>私下推理</think>最终答案')).toBe('最终答案');
  });

  it('未闭合的 think 标签：连同它后面的全部推理原文一起剥离，不留半截正文', () => {
    const leaked = '<think>Long chain of reasoning that never closes because the stream got cut off';
    expect(filterSystemTags(leaked)).toBe('');
  });

  it('未闭合 think 之前的正常正文保留，之后的推理原文剥离', () => {
    const mixed = '这是正常回复。<think>还没想完就断流了';
    expect(filterSystemTags(mixed)).toBe('这是正常回复。');
  });

  it('闭合块 + 之后紧跟一个未闭合块：两段都剥离', () => {
    const text = '<think>第一段</think>正文<think>第二段没关上';
    expect(filterSystemTags(text)).toBe('正文');
  });
});
