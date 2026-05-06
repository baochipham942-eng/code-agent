import { describe, expect, it } from 'vitest';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/main/model/types';
import { XiaomiProvider } from '../../../src/main/model/providers/xiaomiProvider';

class InspectableXiaomiProvider extends XiaomiProvider {
  inspectRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
  ): Record<string, unknown> {
    return this.buildRequestBody(messages, tools, config);
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
});
