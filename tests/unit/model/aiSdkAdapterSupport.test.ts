// aiSdkSupportsProvider —— 锁住「适配器支持哪些 provider」。
// 当前 AI SDK 路径已覆盖所有内置 provider；legacy 回退由 CODE_AGENT_MODEL_ENGINE 控制。
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
});
