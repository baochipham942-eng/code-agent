// 主会话前缀在旁路调用之后仍然命中。
// 正常命中：同一系统提示、不同 user 正文，cache_control 前缀不变。
// 旁路后命中：cacheRetention none 的摘要请求不写前缀槽，下一轮主请求仍命中。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { InferenceOptions, ModelMessage } from '../../../src/host/model/types';
import { ClaudeProvider } from '../../../src/host/model/providers/claudeProvider';
import { electronFetch } from '../../../src/host/model/providers/shared';

vi.mock('../../../src/host/model/providers/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/model/providers/shared')>(
    '../../../src/host/model/providers/shared',
  );
  return {
    ...actual,
    electronFetch: vi.fn(),
  };
});

const mockElectronFetch = vi.mocked(electronFetch);

const CONFIG: ModelConfig = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  apiKey: 'test-key',
};

const TOOL: ToolDefinition = {
  name: 'read',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object', properties: {} },
  requiresPermission: false,
  permissionLevel: 'read',
};

function cacheControlledPrefix(body: Record<string, unknown>): string | null {
  const raw = JSON.stringify(body);
  if (!raw.includes('cache_control')) return null;
  return JSON.stringify({ system: body.system, tools: body.tools });
}

/** 单槽前缀缓存：只有带 cache_control 的请求会写入。旁路不得覆盖它。 */
class PrefixSlot {
  private stored: string | null = null;

  observe(body: Record<string, unknown>): 'hit' | 'miss' | 'bypass' {
    const prefix = cacheControlledPrefix(body);
    if (prefix === null) return 'bypass';
    if (this.stored === prefix) return 'hit';
    this.stored = prefix;
    return 'miss';
  }
}

async function captureBody(
  messages: ModelMessage[],
  options?: InferenceOptions,
): Promise<Record<string, unknown>> {
  mockElectronFetch.mockClear();
  await new ClaudeProvider().inference(messages, [TOOL], CONFIG, undefined, undefined, options);
  const init = mockElectronFetch.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('prefix stability after side-path calls', () => {
  beforeEach(() => {
    mockElectronFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 18 },
      }),
    } as never);
  });

  it('hits the same cache prefix when only the user turn changes', async () => {
    const slot = new PrefixSlot();
    const first = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'turn one' },
    ]);
    const second = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'turn two' },
    ]);

    expect(slot.observe(first)).toBe('miss');
    expect(slot.observe(second)).toBe('hit');
    expect(cacheControlledPrefix(first)).toBe(cacheControlledPrefix(second));
  });

  it('keeps the main-session prefix hit after a cacheRetention none side path', async () => {
    const slot = new PrefixSlot();
    const main = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'continue the task' },
    ]);
    const sidePath = await captureBody(
      [{ role: 'user', content: 'Summarize a different conversation for compaction.' }],
      { cacheRetention: 'none', cacheScopeId: 'compact-summary' },
    );
    const after = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'continue the task' },
    ]);

    expect(JSON.stringify(sidePath)).not.toContain('cache_control');
    expect(slot.observe(main)).toBe('miss');
    expect(slot.observe(sidePath)).toBe('bypass');
    expect(slot.observe(after)).toBe('hit');
  });
});
