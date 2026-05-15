import { describe, expect, it } from 'vitest';
import { parseDiscoveredModelsResponse } from '../../../src/main/ipc/provider.ipc';

describe('provider model discovery parsing', () => {
  it('parses OpenAI-compatible /models responses', () => {
    const models = parseDiscoveredModelsResponse({
      data: [
        { id: 'mimo-v2.5-pro', max_context_length: 1_000_000 },
        { id: 'mimo-v2-tts' },
        { id: 'mimo-v2.5-pro' },
      ],
    });

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'mimo-v2.5-pro',
      label: 'mimo-v2.5-pro',
      maxTokens: 1_000_000,
      supportsTool: true,
    });
    expect(models[0].capabilities).toEqual(expect.arrayContaining(['general']));
    expect(models[1]).toMatchObject({
      id: 'mimo-v2-tts',
      supportsTool: false,
    });
  });

  it('parses Gemini style model names', () => {
    const models = parseDiscoveredModelsResponse({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      ],
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        capabilities: expect.arrayContaining(['fast']),
      }),
    ]);
  });
});
