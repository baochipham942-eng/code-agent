import { describe, expect, it } from 'vitest';
import { resolveModelCapabilities } from '../../../src/host/model/modelCapabilityMatrix';

describe('model capability matrix', () => {
  it('returns safe defaults when no provider entry exists', () => {
    expect(resolveModelCapabilities('unlisted-provider', 'unlisted-model')).toEqual({
      protocol: 'chat-completions',
      search: { mode: 'none' },
      thinking: { interleaved: false },
    });
  });

  it('declares Bailian enable_search for Qwen models', () => {
    expect(resolveModelCapabilities('qwen', 'qwen-flash').search?.mode).toBe('bailian-enable-search');
  });

  it('declares DeepSeek Responses web search without changing its default protocol', () => {
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-flash')).toMatchObject({
      protocol: 'chat-completions',
      search: { mode: 'deepseek-responses' },
    });
  });
});
