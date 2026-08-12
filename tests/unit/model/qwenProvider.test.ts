import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/host/model/types';
import { resolveModelCapabilities } from '../../../src/host/model/modelCapabilityMatrix';
import { QwenProvider } from '../../../src/host/model/providers/qwenProvider';

vi.mock('../../../src/host/model/modelCapabilityMatrix', () => ({
  resolveModelCapabilities: vi.fn(),
}));

class InspectableQwenProvider extends QwenProvider {
  inspectRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
  ): Record<string, unknown> {
    return this.buildRequestBody(messages, tools, config);
  }
}

const mockResolveModelCapabilities = vi.mocked(resolveModelCapabilities);
const config: ModelConfig = { provider: 'qwen', model: 'qwen-flash' };
const messages: ModelMessage[] = [{ role: 'user', content: 'search current news' }];

describe('QwenProvider request body', () => {
  it('adds enable_search only when the capability matrix selects Bailian search', () => {
    const provider = new InspectableQwenProvider();

    mockResolveModelCapabilities.mockReturnValue({
      protocol: 'chat-completions',
      search: { mode: 'bailian-enable-search' },
      thinking: { interleaved: false },
    });
    expect(provider.inspectRequestBody(messages, [], config).enable_search).toBe(true);

    mockResolveModelCapabilities.mockReturnValue({
      protocol: 'chat-completions',
      search: { mode: 'none' },
      thinking: { interleaved: false },
    });
    expect(provider.inspectRequestBody(messages, [], config)).not.toHaveProperty('enable_search');
  });
});
