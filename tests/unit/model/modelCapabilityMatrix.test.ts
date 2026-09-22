import { describe, expect, it } from 'vitest';
import { resolveModelCapabilities } from '../../../src/host/model/modelCapabilityMatrix';
import { getModelScaffoldTier, isAgenticVerifiedModel } from '../../../src/shared/constants/models';

describe('model capability matrix', () => {
  it('returns safe defaults when no provider entry exists', () => {
    expect(resolveModelCapabilities('unlisted-provider', 'unlisted-model')).toEqual({
      protocol: 'chat-completions',
      search: { mode: 'none' },
      thinking: { interleaved: false },
      streamResume: { mode: 'unknown' },
      responsesAtApiRoot: false,
    });
  });

  it('declares Bailian enable_search for Qwen models', () => {
    expect(resolveModelCapabilities('qwen', 'qwen-flash').search?.mode).toBe('bailian-enable-search');
  });

  it('declares DeepSeek Responses web search and protocol as the default', () => {
    expect(resolveModelCapabilities('deepseek', 'deepseek-flash')).toMatchObject({
      protocol: 'responses',
      search: { mode: 'deepseek-responses' },
    });
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-flash')).toMatchObject({
      protocol: 'responses',
      search: { mode: 'deepseek-responses' },
    });
  });

  it('marks deepseek-v4-flash as explicitly tool-call verified without changing its scaffold tier', () => {
    expect(isAgenticVerifiedModel('deepseek-v4-flash')).toBe(true);
    expect(getModelScaffoldTier('deepseek-v4-flash')).toBe('standard');
    // V4.1 Flash 尚未做同款真机工具调用验证，不能借 08-13 那条证据发绿标。
    expect(isAgenticVerifiedModel('deepseek-flash')).toBe(false);
    expect(getModelScaffoldTier('deepseek-flash')).toBe('standard');
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
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-v4-flash').requestCompat)
      .toBeUndefined();
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-flash').requestCompat)
      .toEqual({ deepseekReasoningContent: true });
  });

  it('marks official DeepSeek Responses at the API root and relay models under /v1', () => {
    expect(resolveModelCapabilities('deepseek', 'deepseek-flash').responsesAtApiRoot).toBe(true);
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-flash').responsesAtApiRoot).toBe(true);
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-v4-flash-0731').responsesAtApiRoot).toBe(false);
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-v4-flash').responsesAtApiRoot).toBe(false);
    expect(resolveModelCapabilities('custom-tokenrhythm', 'deepseek-flash')).toMatchObject({
      protocol: 'chat-completions',
      search: { mode: 'none' },
    });
  });

  // ADR-068 D1 刀 0：streamResume 档位数据（纯地基，零行为变化——生产代码尚无消费方）。

  it('resolves DeepSeek to prefix-param with the /beta endpoint override', () => {
    // 官方对话前缀续写（Beta）必须切 api.deepseek.com/beta；provider default 覆盖全部模型。
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-flash').streamResume).toEqual({
      mode: 'prefix-param',
      endpointPath: '/beta',
    });
    expect(resolveModelCapabilities('deepseek', 'deepseek-chat').streamResume).toEqual({
      mode: 'prefix-param',
      endpointPath: '/beta',
    });
  });

  it('resolves documented trailing-assistant providers (openrouter, gemini)', () => {
    expect(resolveModelCapabilities('openrouter', 'anthropic/claude-opus-4-7').streamResume).toEqual({
      mode: 'trailing-assistant',
    });
    expect(resolveModelCapabilities('gemini', 'gemini-3.1-pro-preview').streamResume).toEqual({
      mode: 'trailing-assistant',
    });
  });

  it('resolves OpenAI to none (no official prefix/continuation parameter)', () => {
    expect(resolveModelCapabilities('openai', 'gpt-5.5').streamResume).toEqual({ mode: 'none' });
  });

  it('splits Claude by model generation: 4.6+ none, <=4.5 trailing-assistant', () => {
    // ADR-068 as-built 备注 3：Anthropic prefill 在 Claude 4.6+ 返回 400（含仓内默认 claude-opus-4-7）。
    expect(resolveModelCapabilities('claude', 'claude-opus-4-7').streamResume).toEqual({ mode: 'none' });
    expect(resolveModelCapabilities('claude', 'claude-sonnet-4-6').streamResume).toEqual({ mode: 'none' });
    // ≤4.5 prefill 官方文档化，逐模型升档；同条目不得破坏既有 thinking.interleaved 声明。
    expect(resolveModelCapabilities('claude', 'claude-opus-4-5-20251101')).toMatchObject({
      streamResume: { mode: 'trailing-assistant' },
      thinking: { interleaved: true },
    });
    expect(resolveModelCapabilities('claude', 'claude-sonnet-4-5-20250929').streamResume).toEqual({
      mode: 'trailing-assistant',
    });
    expect(resolveModelCapabilities('claude', 'claude-haiku-4-5-20251001').streamResume).toEqual({
      mode: 'trailing-assistant',
    });
    expect(resolveModelCapabilities('claude', 'claude-opus-4-1-20250805').streamResume).toEqual({
      mode: 'trailing-assistant',
    });
  });

  it('falls back to unknown for providers without a documented resume contract', () => {
    // OpenAI 兼容协议无公开 prefix 续写合同（2026-09-14 检索未命中官方文档）——一律 B2 兜底。
    const unverified: Array<[string, string]> = [
      ['moonshot', 'kimi-k2.5'],
      ['zhipu', 'glm-5'],
      ['qwen', 'qwen3-max'],
      ['minimax', 'MiniMax-M2.7'],
      ['grok', 'grok-4-1-fast-non-reasoning'],
      ['volcengine', 'doubao-1.5-pro-256k'],
      ['longcat', 'LongCat-2.0'],
      ['xiaomi', 'mimo-v2.5-pro'],
      ['groq', 'llama-3.3-70b-versatile'],
      ['perplexity', 'sonar-pro'],
      ['local', 'qwen2.5-coder:7b'],
      ['custom', 'custom-model'],
      ['custom-tokenrhythm', 'deepseek-v4-flash-0731'],
    ];
    for (const [provider, model] of unverified) {
      expect(resolveModelCapabilities(provider, model).streamResume, `${provider}/${model}`).toEqual({
        mode: 'unknown',
      });
    }
  });
});
