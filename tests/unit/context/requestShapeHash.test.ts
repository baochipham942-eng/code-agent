import { describe, expect, it } from 'vitest';
import { computeRequestPrefixShapeHash } from '../../../src/host/context/requestShapeHash';

// WP2-2b：请求前缀 shape hash — 仅 telemetry 诊断，用于量化压缩打掉 prefix cache。
// shape = systemPrompt + 每条消息的 role/内容长度/工具调用数（结构，不含全文）。

const MSGS = [
  { role: 'user', content: 'hello world' },
  { role: 'assistant', content: 'hi', toolCalls: [{ id: 'c1' }] },
  { role: 'tool', content: 'result text' },
];

describe('computeRequestPrefixShapeHash', () => {
  it('is deterministic for identical input', () => {
    const a = computeRequestPrefixShapeHash({ systemPrompt: 'sys', messages: MSGS });
    const b = computeRequestPrefixShapeHash({ systemPrompt: 'sys', messages: MSGS });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when the system prompt changes', () => {
    const a = computeRequestPrefixShapeHash({ systemPrompt: 'sys-a', messages: MSGS });
    const b = computeRequestPrefixShapeHash({ systemPrompt: 'sys-b', messages: MSGS });
    expect(a).not.toBe(b);
  });

  it('changes when a message is removed (compaction)', () => {
    const a = computeRequestPrefixShapeHash({ systemPrompt: 'sys', messages: MSGS });
    const b = computeRequestPrefixShapeHash({ systemPrompt: 'sys', messages: MSGS.slice(1) });
    expect(a).not.toBe(b);
  });

  it('changes when message content length changes', () => {
    const mutated = [{ ...MSGS[0], content: 'hello world TRUNCATED MORE' }, ...MSGS.slice(1)];
    const a = computeRequestPrefixShapeHash({ systemPrompt: 'sys', messages: MSGS });
    const b = computeRequestPrefixShapeHash({ systemPrompt: 'sys', messages: mutated });
    expect(a).not.toBe(b);
  });

  it('tolerates missing systemPrompt and undefined content', () => {
    const hash = computeRequestPrefixShapeHash({ messages: [{ role: 'user' }] });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
