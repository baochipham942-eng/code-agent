// aiSdkSupportsProvider —— 锁住「适配器支持哪些 provider/model」。
// 非 chat-completions 协议必须回落 legacy，由它按协议分派。
import { describe, expect, it, vi } from 'vitest';
import { aiSdkSupportsProvider } from '../../../src/host/model/adapters/aiSdkAdapter';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('aiSdkSupportsProvider', () => {
  it('all built-in providers use the AI SDK path by default', () => {
    for (const p of [
      'deepseek',
      'claude',
      'anthropic',
      'openai',
      'groq',
      'qwen',
      'minimax',
      'perplexity',
      'volcengine',
      'longcat',
      'local',
      'gemini',
      'xiaomi',
      'moonshot',
      'zhipu',
      'openrouter',
    ]) {
      expect(aiSdkSupportsProvider(p)).toBe(true);
    }
  });

  it('让 DeepSeek Responses 模型回落 legacy，但不连累 chat-completions 模型', () => {
    expect(aiSdkSupportsProvider('deepseek', 'deepseek-v4-flash')).toBe(false);
    expect(aiSdkSupportsProvider('deepseek', 'deepseek-chat')).toBe(true);
  });

  it('未传 model 时保持 provider 级调用的向后兼容', () => {
    expect(aiSdkSupportsProvider('deepseek')).toBe(true);
  });
});
