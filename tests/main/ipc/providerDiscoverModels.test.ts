import { describe, expect, it } from 'vitest';
import {
  filterDiscoveredModelsForProvider,
  parseDiscoveredModelsResponse,
} from '../../../src/main/ipc/provider.ipc';

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

  it('parses Claude style display names', () => {
    const models = parseDiscoveredModelsResponse({
      data: [
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      ],
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
      }),
    ]);
  });

  it('keeps only Claude-family models for Claude providers backed by mixed relays', () => {
    const models = parseDiscoveredModelsResponse({
      data: [
        { id: 'anthropic/claude-opus-4-8' },
        { id: 'google/gemini-3.5-flash' },
        { id: 'openai/gpt-5.5' },
        { id: 'claude-sonnet-4-6' },
      ],
    });

    const expected = [
      'anthropic/claude-opus-4-8',
      'claude-sonnet-4-6',
    ];
    expect(filterDiscoveredModelsForProvider('claude', models).map((model) => model.id)).toEqual(expected);
    expect(filterDiscoveredModelsForProvider('custom-commonstack-claude', models).map((model) => model.id)).toEqual(expected);
    expect(filterDiscoveredModelsForProvider('custom-scydao', models, 'claude').map((model) => model.id)).toEqual(expected);
  });

  it('filters mixed relay results for named vendor providers', () => {
    const models = parseDiscoveredModelsResponse({
      data: [
        { id: 'anthropic/claude-opus-4-8' },
        { id: 'openai/gpt-5.5' },
        { id: 'gpt-4o-mini' },
        { id: 'google/gemini-3.5-flash' },
        { id: 'gemini-2.5-pro' },
        { id: 'deepseek/deepseek-v4-pro' },
        { id: 'deepseek-chat' },
        { id: 'moonshotai/kimi-k2.6' },
        { id: 'kimi-k2.5' },
        { id: 'zai-org/glm-5.1' },
        { id: 'glm-4-flash' },
        { id: 'qwen/qwen3-max' },
        { id: 'qwen-plus' },
        { id: 'minimax/minimax-m2.7' },
        { id: 'xiaomi/mimo-v2-pro' },
        { id: 'mimo-v2.5-pro' },
        { id: 'xai/grok-4-1-fast' },
        { id: 'grok-4-1-fast-non-reasoning' },
        { id: 'perplexity/sonar-pro' },
        { id: 'sonar-reasoning-pro' },
        { id: 'doubao-seed-1-6' },
        { id: 'LongCat-2.0-Preview' },
      ],
    });

    const idsFor = (provider: string) =>
      filterDiscoveredModelsForProvider(provider, models).map((model) => model.id);

    expect(idsFor('custom-commonstack-openai')).toEqual(['openai/gpt-5.5', 'gpt-4o-mini']);
    expect(idsFor('custom-commonstack-gemini')).toEqual(['google/gemini-3.5-flash', 'gemini-2.5-pro']);
    expect(idsFor('custom-commonstack-deepseek')).toEqual(['deepseek/deepseek-v4-pro', 'deepseek-chat']);
    expect(idsFor('custom-commonstack-kimi')).toEqual(['moonshotai/kimi-k2.6', 'kimi-k2.5']);
    expect(idsFor('custom-commonstack-glm')).toEqual(['zai-org/glm-5.1', 'glm-4-flash']);
    expect(idsFor('custom-commonstack-qwen')).toEqual(['qwen/qwen3-max', 'qwen-plus']);
    expect(idsFor('custom-commonstack-minimax')).toEqual(['minimax/minimax-m2.7']);
    expect(idsFor('custom-commonstack-mimo')).toEqual(['xiaomi/mimo-v2-pro', 'mimo-v2.5-pro']);
    expect(idsFor('custom-commonstack-grok')).toEqual(['xai/grok-4-1-fast', 'grok-4-1-fast-non-reasoning']);
    expect(idsFor('custom-commonstack-x-ai')).toEqual(['xai/grok-4-1-fast', 'grok-4-1-fast-non-reasoning']);
    expect(idsFor('custom-commonstack-sonar')).toEqual(['perplexity/sonar-pro', 'sonar-reasoning-pro']);
    expect(idsFor('custom-commonstack-doubao')).toEqual(['doubao-seed-1-6']);
    expect(idsFor('custom-commonstack-longcat')).toEqual(['LongCat-2.0-Preview']);
  });

  it('does not filter neutral custom providers backed by mixed relays', () => {
    const models = parseDiscoveredModelsResponse({
      data: [
        { id: 'anthropic/claude-opus-4-8' },
        { id: 'google/gemini-3.5-flash' },
      ],
    });

    expect(filterDiscoveredModelsForProvider('custom-commonstack', models).map((model) => model.id)).toEqual([
      'anthropic/claude-opus-4-8',
      'google/gemini-3.5-flash',
    ]);
  });
});
