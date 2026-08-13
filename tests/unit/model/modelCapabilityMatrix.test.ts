import { describe, expect, it } from 'vitest';
import { resolveModelCapabilities } from '../../../src/host/model/modelCapabilityMatrix';
import { getModelScaffoldTier, isAgenticVerifiedModel } from '../../../src/shared/constants/models';

describe('model capability matrix', () => {
  it('returns safe defaults when no provider entry exists', () => {
    expect(resolveModelCapabilities('unlisted-provider', 'unlisted-model')).toEqual({
      protocol: 'chat-completions',
      search: { mode: 'none' },
      thinking: { interleaved: false },
      responsesAtApiRoot: false,
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

  it('marks deepseek-v4-flash as explicitly tool-call verified without changing its scaffold tier', () => {
    expect(isAgenticVerifiedModel('deepseek-v4-flash')).toBe(true);
    expect(getModelScaffoldTier('deepseek-v4-flash')).toBe('standard');
  });

  it('resolves relay deepseek-v4-flash-0731 to Responses protocol with web search', () => {
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-v4-flash-0731')).toMatchObject({
      protocol: 'responses',
      search: { mode: 'deepseek-responses' },
    });
  });

  it('does not let the relay inherit official DeepSeek capabilities for same-name models', () => {
    // 验收判据：2026-08-13 实测同名 deepseek-v4-flash 被中转上游 400 拒绝，必须降级。
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-v4-flash')).toMatchObject({
      protocol: 'chat-completions',
      search: { mode: 'none' },
    });
  });

  it('marks official DeepSeek Responses at the API root and relay models under /v1', () => {
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-flash').responsesAtApiRoot).toBe(true);
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-v4-flash-0731').responsesAtApiRoot).toBe(false);
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-v4-flash').responsesAtApiRoot).toBe(false);
  });
});
