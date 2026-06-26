import { describe, expect, it } from 'vitest';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/host/model/types';
import { XiaomiProvider } from '../../../src/host/model/providers/xiaomiProvider';

class InspectableXiaomiProvider extends XiaomiProvider {
  inspectRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
  ): Record<string, unknown> {
    return this.buildRequestBody(messages, tools, config);
  }

  inspectShouldUseReasoningEffort(config: ModelConfig): boolean {
    return this.shouldUseReasoningEffort(config);
  }
}

describe('XiaomiProvider request body', () => {
  it('uses max_completion_tokens for MiMo OpenAI compatibility', () => {
    const provider = new InspectableXiaomiProvider();

    const body = provider.inspectRequestBody(
      [{ role: 'user', content: 'repair this artifact' }],
      [],
      {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        maxTokens: 131072,
      },
    );

    expect(body.max_completion_tokens).toBe(131072);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('disables MiMo thinking by default so long artifacts produce visible content', () => {
    const provider = new InspectableXiaomiProvider();

    const body = provider.inspectRequestBody(
      [{ role: 'user', content: '开发一个html弹砖块游戏，要求技能和关卡丰富，可玩性强' }],
      [],
      {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        maxTokens: 24000,
      },
    );

    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('uses Xiaomi official thinking control instead of reasoning_effort', () => {
    const provider = new InspectableXiaomiProvider();

    expect(provider.inspectShouldUseReasoningEffort({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
    })).toBe(false);

    const body = provider.inspectRequestBody(
      [{ role: 'user', content: 'think harder' }],
      [],
      {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        reasoningEffort: 'high',
      },
    );

    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.thinking).toEqual({ type: 'enabled' });
  });
});
