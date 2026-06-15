// AI SDK 6 会在 messages/prompt 里发现 role:system 时打 warning；适配器应把系统指令
// 放到顶层 system option，并确保传给 streamText/generateText 的 messages 不再含 system。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/main/model/adapters/aiSdkAdapter';
import type { ModelMessage, StreamCallback } from '../../../src/main/model/types';
import type { ModelConfig, ToolDefinition } from '../../../src/main/shared/contract';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/main/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));

vi.mock('../../../src/main/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({ recordSuccess: vi.fn(), recordFailure: vi.fn() }),
}));

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

const CONFIG: ModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  temperature: 0.7,
} as ModelConfig;

const TASK_TOOL: ToolDefinition = {
  name: 'Task',
  description: 'launch a subagent',
  inputSchema: { type: 'object', properties: { subagent_type: { type: 'string' } }, required: [] },
} as ToolDefinition;

type CapturedAiSdkCall = {
  system?: Array<{ role: 'system'; content: string }>;
  messages: Array<{ role: string; content: unknown }>;
  allowSystemInMessages?: boolean;
};

function finishOnlyStream() {
  return {
    fullStream: (async function* () {
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    })(),
  } as unknown as ReturnType<typeof streamText>;
}

function expectNoSystemMessages(call: CapturedAiSdkCall): void {
  expect(call.system?.map((m) => m.role)).toEqual(call.system?.map(() => 'system'));
  expect(call.messages.some((m) => m.role === 'system')).toBe(false);
  expect(call.allowSystemInMessages).toBeUndefined();
}

beforeEach(() => {
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
  vi.mocked(generateText).mockResolvedValue({
    text: 'ok',
    toolCalls: [],
    reasoningText: '',
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop',
  } as unknown as Awaited<ReturnType<typeof generateText>>);
  vi.mocked(streamText).mockReturnValue(finishOnlyStream());
});

describe('inferenceViaAiSdk system prompt wiring', () => {
  it('非流式 generateText：system 走顶层 option，messages 不再含 system role', async () => {
    await inferenceViaAiSdk([
      { role: 'system', content: 'root system prompt' },
      { role: 'user', content: 'hello' },
    ], [], CONFIG);

    const call = vi.mocked(generateText).mock.calls[0][0] as CapturedAiSdkCall;
    expect(call.system).toEqual([{ role: 'system', content: 'root system prompt' }]);
    expect(call.messages.map((m) => m.role)).toEqual(['user']);
    expectNoSystemMessages(call);
  });

  it('流式 streamText：抽走夹层 system，同时保留 assistant tool-call → tool-result 顺序', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'root system prompt' },
      { role: 'user', content: 'launch task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_00', name: 'Task', arguments: JSON.stringify({ subagent_type: 'explore' }) }],
      } as ModelMessage,
      { role: 'system', content: '<post-tool-hook>note</post-tool-hook>' },
      { role: 'tool', content: 'task result', toolCallId: 'call_00' } as ModelMessage,
      { role: 'system', content: '<auto-continuation>continue</auto-continuation>' },
    ];
    const noopStream: StreamCallback = () => {};

    await inferenceViaAiSdk(messages, [TASK_TOOL], CONFIG, noopStream);

    const call = vi.mocked(streamText).mock.calls[0][0] as CapturedAiSdkCall;
    expect(call.system?.map((m) => m.content)).toEqual([
      'root system prompt',
      '<post-tool-hook>note</post-tool-hook>',
      '<auto-continuation>continue</auto-continuation>',
    ]);
    expect(call.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(call.messages[1].role).toBe('assistant');
    expect(call.messages[2].role).toBe('tool');
    expectNoSystemMessages(call);
  });
});
