// aiSdkSupportsProvider —— 锁住「适配器支持哪些 provider」，子代理默认走 aisdk 后，
// 不支持的 provider（gemini 原生 API）必须自动回退旧 modelRouter 路径。
import { describe, expect, it, vi } from 'vitest';
import { aiSdkSupportsProvider } from '../../../src/main/model/adapters/aiSdkAdapter';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('aiSdkSupportsProvider', () => {
  it('gemini 原生 API 不支持 → false（子代理回退旧路径）', () => {
    expect(aiSdkSupportsProvider('gemini')).toBe(false);
  });

  it('deepseek / claude / 各 OpenAI 兼容 provider 支持 → true', () => {
    for (const p of ['deepseek', 'claude', 'anthropic', 'zhipu', 'xiaomi', 'moonshot', 'openai', 'longcat']) {
      expect(aiSdkSupportsProvider(p)).toBe(true);
    }
  });
});
