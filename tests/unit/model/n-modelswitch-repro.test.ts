import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamText = vi.hoisted(() => vi.fn());
const generateText = vi.hoisted(() => vi.fn());
const electronFetch = vi.hoisted(() => vi.fn());

vi.mock('ai', async (importActual) => ({
  ...(await importActual<typeof import('ai')>()),
  streamText,
  generateText,
}));
vi.mock('../../../src/host/model/providers/providerHttp', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/host/model/providers/providerHttp')>()),
  electronFetch,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({}),
    getApiKey: () => 'test-key',
    onSettingsUpdated: vi.fn(),
  }),
}));

import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import { ModelRouter } from '../../../src/host/model/modelRouter';
import type { ModelMessage } from '../../../src/host/model/types';

const HISTORY: ModelMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in the image?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ],
  },
  { role: 'assistant', content: 'It is a diagram.', thinking: 'hidden reasoning' },
  { role: 'user', content: 'Continue.' },
];

describe('N-MODELSWITCH-REPLAY as-built reproduction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateText.mockResolvedValue({ text: 'ok', toolCalls: [], usage: {}, finishReason: 'stop' });
    electronFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
  });

  it('AI SDK path replaces unsupported images and removes reasoning before assembly', async () => {
    await inferenceViaAiSdk(HISTORY, [], {
      provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key',
    } as any);
    expect(generateText.mock.calls[0][0].messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in the image?' },
          { type: 'text', text: '[Image omitted: the current model cannot view images.]' },
        ],
      },
      { role: 'assistant', content: 'It is a diagram.' },
      { role: 'user', content: 'Continue.' },
    ]);
    expect(HISTORY[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }),
    ]));

    await inferenceViaAiSdk([
      { role: 'assistant', content: 'visible', thinking: 'must not be sent' },
      { role: 'user', content: 'Continue.' },
    ], [], {
      provider: 'xai', model: 'grok-4-1-fast-non-reasoning', apiKey: 'test-key',
    } as any);
    expect(generateText.mock.calls[1][0].messages).toEqual([
      { role: 'assistant', content: 'visible' },
      { role: 'user', content: 'Continue.' },
    ]);

    await inferenceViaAiSdk(HISTORY, [], {
      provider: 'claude', model: 'claude-opus-4-7', apiKey: 'test-key',
    } as any);
    expect(generateText.mock.calls[2][0].messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is in the image?' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
    });
    expect(HISTORY[1].thinking).toBe('hidden reasoning');
  });

  it('legacy router path sends a sanitized body to a text-only non-reasoning target', async () => {

    await new ModelRouter().inference(HISTORY, [], {
      provider: 'custom', model: 'text-only', apiKey: 'test-key', baseUrl: 'https://test.local/v1',
    } as any, undefined, undefined, { forceNonStreaming: true, disableProviderTransientRetry: true });

    const body = JSON.parse(electronFetch.mock.calls[0][1].body as string);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in the image?' },
          { type: 'text', text: '[Image omitted: the current model cannot view images.]' },
        ],
      },
      { role: 'assistant', content: 'It is a diagram.' },
      { role: 'user', content: 'Continue.' },
    ]);
  });
});
