import { Readable } from 'node:stream';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import { ORPHANED_TOOL_CALL_PLACEHOLDER } from '../../../src/host/model/providers/shared';
import type { ModelMessage } from '../../../src/host/model/types';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';

const logMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logMocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));

vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({ recordSuccess: vi.fn(), recordFailure: vi.fn() }),
}));

vi.mock('axios', () => ({ default: vi.fn() }));

const CONFIG = {
  provider: 'custom-tokenrhythm',
  model: 'deepseek-v4-flash',
  temperature: 0.7,
} as ModelConfig;

const TASK_TOOL: ToolDefinition = {
  name: 'Task',
  description: 'launch a subagent',
  outputSchema: { type: 'string' },
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: true,
  permissionLevel: 'execute',
};

function successfulCompletion() {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    data: Readable.from([JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: CONFIG.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })]),
  };
}

async function serializedMessages(messages: ModelMessage[]): Promise<Array<Record<string, unknown>>> {
  vi.mocked(axios).mockResolvedValueOnce(successfulCompletion());
  await inferenceViaAiSdk(messages, [TASK_TOOL], CONFIG);
  const request = vi.mocked(axios).mock.calls.at(-1)?.[0] as unknown as { data: string };
  return (JSON.parse(request.data) as { messages: Array<Record<string, unknown>> }).messages;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI SDK chat wire payload tool pairing repair', () => {
  it('keeps an already paired history byte-for-byte equivalent at the wire-message level and emits no warning', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'run task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_paired', name: 'Task', arguments: '{}' }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call_paired' },
      { role: 'user', content: 'continue' },
    ];

    const wireMessages = await serializedMessages(messages);

    expect(wireMessages).toEqual([
      { role: 'user', content: 'run task' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_paired', type: 'function', function: { name: 'Task', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_paired', content: 'ok' },
      { role: 'user', content: 'continue' },
    ]);
    expect(logMocks.warn).not.toHaveBeenCalled();
  });

  it('preserves an orphan tool call, synthesizes its missing result in the final request, and warns once', async () => {
    const wireMessages = await serializedMessages([
      { role: 'user', content: 'run task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_missing_result', name: 'Task', arguments: '{}' }],
      },
      { role: 'user', content: 'continue' },
    ]);

    expect(wireMessages).toEqual([
      { role: 'user', content: 'run task' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_missing_result', type: 'function', function: { name: 'Task', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_missing_result', content: ORPHANED_TOOL_CALL_PLACEHOLDER },
      { role: 'user', content: 'continue' },
    ]);
    expect(logMocks.warn).toHaveBeenCalledTimes(1);
    expect(logMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('orphaned tool call'),
      {
        callId: 'call_missing_result',
        missingSide: 'tool_result',
        messageIndex: 1,
        toolCallIndex: 0,
      },
    );
  });

  it('drops an orphan tool result from the final request and warns once with its source position', async () => {
    const wireMessages = await serializedMessages([
      { role: 'user', content: 'run task' },
      { role: 'tool', content: 'stale result', toolCallId: 'call_missing_call' },
      { role: 'user', content: 'continue' },
    ]);

    expect(wireMessages).toEqual([
      { role: 'user', content: 'run task' },
      { role: 'user', content: 'continue' },
    ]);
    expect(logMocks.warn).toHaveBeenCalledTimes(1);
    expect(logMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('orphaned tool result'),
      { callId: 'call_missing_call', missingSide: 'tool_call', messageIndex: 1 },
    );
  });

  it('produces the same repaired wire request and warning for in-memory and JSON-rehydrated histories', async () => {
    const inMemory: ModelMessage[] = [
      { role: 'user', content: 'run task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_rehydrated', name: 'Task', arguments: '{"source":"history"}' }],
      },
      { role: 'user', content: 'continue' },
    ];

    const inMemoryWire = await serializedMessages(inMemory);
    const inMemoryWarnings = logMocks.warn.mock.calls.map((call) => call.slice());
    logMocks.warn.mockClear();
    const rehydrated = JSON.parse(JSON.stringify(inMemory)) as ModelMessage[];
    const rehydratedWire = await serializedMessages(rehydrated);

    expect(rehydratedWire).toEqual(inMemoryWire);
    expect(logMocks.warn.mock.calls).toEqual(inMemoryWarnings);
    expect(logMocks.warn).toHaveBeenCalledTimes(1);
  });
});
