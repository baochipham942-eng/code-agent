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

  it('declares DeepSeek Responses web search and protocol as the default', () => {
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-flash')).toMatchObject({
      protocol: 'responses',
      search: { mode: 'deepseek-responses' },
    });
  });
});
