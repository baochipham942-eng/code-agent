// aiSdkSupportsProvider —— 锁住「适配器支持哪些 provider」，子代理默认走 aisdk 后，
// 不支持的 provider（gemini 原生 API）必须自动回退旧 modelRouter 路径。
import { describe, expect, it, vi } from 'vitest';
import { aiSdkSupportsProvider } from '../../../src/main/model/adapters/aiSdkAdapter';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('aiSdkSupportsProvider', () => {
  it('provider class 语义尚未等价的 provider 不进 AI SDK 默认路径 → false（回退旧路径）', () => {
    expect(aiSdkSupportsProvider('gemini')).toBe(false);
    expect(aiSdkSupportsProvider('xiaomi')).toBe(false);
    expect(aiSdkSupportsProvider('moonshot')).toBe(false);
    expect(aiSdkSupportsProvider('zhipu')).toBe(false);
    expect(aiSdkSupportsProvider('openrouter')).toBe(false);
  });

  it('DeepSeek / Claude / 普通 OpenAI 兼容 provider 支持 → true', () => {
    for (const p of ['deepseek', 'claude', 'anthropic', 'openai', 'groq', 'qwen', 'minimax', 'perplexity', 'volcengine', 'longcat', 'local']) {
      expect(aiSdkSupportsProvider(p)).toBe(true);
    }
  });
});
