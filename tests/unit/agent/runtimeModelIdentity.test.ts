import { describe, expect, it } from 'vitest';
import { injectRuntimeModelIdentity } from '../../../src/host/agent/runtime/contextAssembly/runtimeModelIdentity';

describe('runtime model identity prompt', () => {
  it('injects the exact model name once, provider only as disambiguation context', () => {
    const prompt = injectRuntimeModelIdentity('base prompt', 'longcat', 'LongCat-Flash-Chat');
    expect(prompt).toContain('当前会话实际使用的模型是 LongCat-Flash-Chat（provider: longcat）');
    expect(prompt).toContain('直接回答模型名「LongCat-Flash-Chat」');
    expect(injectRuntimeModelIdentity(prompt, 'longcat', 'LongCat-Flash-Chat')).toBe(prompt);
  });
});
