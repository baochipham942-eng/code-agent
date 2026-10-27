// checkpoint writer 的默认模型解析：用户配置的 models.default 优先，未配置才落出厂默认；
// moonshot 的 KIMI_K25_API_KEY 环境兜底与 no-key 错误文案保持不变。
// 真模型不真发——ModelRouter 与 configService 全部替身，只断言 inference 收到的 config。
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { CHECKPOINT_WRITER, DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../../src/shared/constants';

const h = vi.hoisted(() => ({
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string; baseUrl?: string }>,
    },
  },
  apiKey: 'test-key' as string,
  inference: vi.fn(async (_messages: unknown, _tools: unknown, _config: unknown) => ({ content: '' })),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: (provider: string) => (provider ? h.apiKey : ''),
  }),
}));

vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    inference(messages: unknown, tools: unknown, config: unknown) {
      return h.inference(messages, tools, config);
    }
  },
}));

import { runCheckpointWriterAgent, type CheckpointWriterJob } from '../../../src/host/agent/checkpointWriterAgent';

function message(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 } as Message;
}

function inferenceConfig(): Record<string, unknown> {
  const config = h.inference.mock.calls[0]?.[2];
  if (!config || typeof config !== 'object') throw new Error('inference not called');
  return config as Record<string, unknown>;
}

describe('checkpoint writer default model', () => {
  let rootDir: string;

  beforeEach(async () => {
    h.inference.mockClear();
    h.settings.models.default = '';
    h.settings.models.providers = {};
    h.apiKey = 'test-key';
    delete process.env.KIMI_K25_API_KEY;
    rootDir = await mkdtemp(path.join(tmpdir(), 'ckpt-writer-default-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    delete process.env.KIMI_K25_API_KEY;
  });

  function job(): CheckpointWriterJob {
    return {
      sessionId: 'session-writer-default',
      workingDirectory: '/tmp/project',
      messages: [message('m1', 'user', '继续 checkpoint writer 返工')],
      reason: 'manual',
      rootDir,
      now: 1_000,
    };
  }

  it('calls the LLM on the configured user provider and model', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.test/v1' } };

    const result = await runCheckpointWriterAgent(job());

    // inference 替身返回空 content → writer fail-closed，但模型选择已在调用参数里
    expect(result.success).toBe(false);
    expect(inferenceConfig()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.test/v1',
      temperature: CHECKPOINT_WRITER.LLM_TEMPERATURE,
      maxTokens: CHECKPOINT_WRITER.LLM_MAX_OUTPUT_TOKENS,
    });
  });

  it('calls the LLM on the factory default when nothing is configured', async () => {
    const result = await runCheckpointWriterAgent(job());

    expect(result.success).toBe(false);
    expect(inferenceConfig()).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODELS.chat,
    });
  });

  it('keeps the moonshot env fallback and the no-key error text', async () => {
    h.settings.models.default = 'moonshot';
    h.settings.models.providers = { moonshot: { model: 'kimi-k2.5' } };
    h.apiKey = '';
    process.env.KIMI_K25_API_KEY = 'env-kimi-key';

    const result = await runCheckpointWriterAgent(job());

    expect(result.success).toBe(false);
    expect(inferenceConfig()).toMatchObject({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      apiKey: 'env-kimi-key',
    });

    // 非 moonshot 无 key：错误文案原样（env 兜底不适用）
    h.inference.mockClear();
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };
    delete process.env.KIMI_K25_API_KEY;
    const noKey = await runCheckpointWriterAgent(job());
    expect(noKey.success).toBe(false);
    expect(noKey.error).toContain(`checkpoint writer: no API key available for provider deepseek`);
  });
});
