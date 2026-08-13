import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/host/model/types';
import { resolveModelCapabilities } from '../../../src/host/model/modelCapabilityMatrix';
import { QwenProvider } from '../../../src/host/model/providers/qwenProvider';

// 默认值必须是真实矩阵形状：providerRegistry 模块加载时会逐模型调一次
// resolveModelCapabilities 回填 'search' 标签，空 mock 会让注册表 import 即炸。
// vi.mock 工厂被提升，默认值也要 hoist 上去。
const MATRIX_DEFAULT = vi.hoisted(() => ({
  protocol: 'chat-completions',
  search: { mode: 'none' },
  thinking: { interleaved: false },
}) as const);

vi.mock('../../../src/host/model/modelCapabilityMatrix', () => ({
  resolveModelCapabilities: vi.fn(() => ({ ...MATRIX_DEFAULT, search: { ...MATRIX_DEFAULT.search } })),
}));

class InspectableQwenProvider extends QwenProvider {
  inspectRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    options?: { searchEnabled?: boolean },
  ): Record<string, unknown> {
    return this.buildRequestBody(messages, tools, config, options);
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

  it('omits enable_search when the per-turn search toggle is off, even when the matrix allows it', () => {
    const provider = new InspectableQwenProvider();
    mockResolveModelCapabilities.mockReturnValue({
      protocol: 'chat-completions',
      search: { mode: 'bailian-enable-search' },
      thinking: { interleaved: false },
    });

    expect(provider.inspectRequestBody(messages, [], config, { searchEnabled: false }))
      .not.toHaveProperty('enable_search');
    expect(provider.inspectRequestBody(messages, [], config, { searchEnabled: true }).enable_search)
      .toBe(true);
    // 未传 options（旧调用方）保持现状：矩阵允许就挂
    expect(provider.inspectRequestBody(messages, [], config).enable_search).toBe(true);
  });
});
