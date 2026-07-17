// AI SDK 适配器消息排序 —— 锁住 toAiMessages 输出满足 AI SDK 的 tool-call/tool-result 配对约束。
// 回归背景：主 loop 在 tool 执行期间（tool-result 消息入列前）会经 injectSystemMessage 注入 system
// 消息（post-tool hook、失败告警、nudge 等），使 runtime.messages 出现
// assistant(tool-call) → system → tool(result) 的顺序。AI SDK 严格要求 tool-result 紧跟
// assistant(tool-call)，中间夹 system/user 会抛 MissingToolResultsError（"Tool result is missing
// for tool call ..."）。旧 OpenAI 路径 providers/shared.ts:sanitizeToolCallOrder 已把夹层 system
// 移到 tool-result 之后；迁移到 AI SDK 适配器时漏带这层重排，导致主 loop + 子代理(Task)场景 RUN_FAILED。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { streamText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { ModelMessage, StreamCallback } from '../../../src/host/model/types';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));

vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({ recordSuccess: vi.fn(), recordFailure: vi.fn() }),
}));

// 只桩 streamText（捕获其收到的 messages = toAiMessages 输出），保留 tool()/jsonSchema 真实实现。
vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, streamText: vi.fn() };
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
  requiresPermission: true,
  permissionLevel: 'execute',
};

// 流只发一个 finish，让 streamViaAiSdk 直接收尾返回（本测试只关心传入的 messages）。
function finishOnlyStream() {
  return {
    fullStream: (async function* () {
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    })(),
  } as unknown as ReturnType<typeof streamText>;
}

const noopStream: StreamCallback = () => {};

/**
 * 复刻 node_modules/ai dist 的 tool-result 校验（index.js: combine 连续 tool 消息后，
 * assistant 累积 tool-call id，遇 user/system 时若仍有未配对 id 即抛；末尾仍有未配对也抛）。
 * 用于在不发真实请求的前提下断言 toAiMessages 的输出是否会被 AI SDK 拒绝。
 */
function assertAiSdkToolPairing(aiMessages: Array<Record<string, unknown>>): void {
  const combined: Array<{ role: string; content: unknown }> = [];
  for (const m of aiMessages) {
    if (m.role !== 'tool') {
      combined.push(m as { role: string; content: unknown });
      continue;
    }
    const last = combined.at(-1);
    if (last?.role === 'tool') {
      (last.content as unknown[]).push(...(m.content as unknown[]));
    } else {
      combined.push({ role: 'tool', content: [...(m.content as unknown[])] });
    }
  }
  const pending = new Set<string>();
  for (const m of combined) {
    if (m.role === 'assistant') {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const c of parts as Array<Record<string, unknown>>) {
        if (c.type === 'tool-call') pending.add(c.toolCallId as string);
      }
    } else if (m.role === 'tool') {
      for (const c of m.content as Array<Record<string, unknown>>) {
        if (c.type === 'tool-result') pending.delete(c.toolCallId as string);
      }
    } else if (m.role === 'user' || m.role === 'system') {
      if (pending.size > 0) {
        throw new Error(`Tool results are missing for tool calls ${[...pending].join(', ')}.`);
      }
    }
  }
  if (pending.size > 0) {
    throw new Error(`Tool results are missing for tool calls ${[...pending].join(', ')}.`);
  }
}

async function captureAiMessages(messages: ModelMessage[]): Promise<Array<Record<string, unknown>>> {
  let captured: Array<Record<string, unknown>> = [];
  vi.mocked(streamText).mockImplementation((opts: Parameters<typeof streamText>[0]) => {
    captured = (opts as { messages: Array<Record<string, unknown>> }).messages;
    return finishOnlyStream();
  });
  await inferenceViaAiSdk(messages, [TASK_TOOL], CONFIG, noopStream);
  return captured;
}

beforeEach(() => {
  vi.mocked(streamText).mockReset();
});

describe('toAiMessages —— tool-call/tool-result 配对排序', () => {
  it('夹在 assistant(tool-call) 与 tool-result 之间的 system 消息：reorder 后不触发 AI SDK MissingToolResults', async () => {
    // 复现回归：assistant(Task call_00) → system(失败告警) → tool(call_00 结果)
    const messages: ModelMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '请用 Task 启动 explore 子代理' },
      {
        role: 'assistant',
        content: '好的，我来启动子代理',
        toolCalls: [{ id: 'call_00', name: 'Task', arguments: JSON.stringify({ subagent_type: 'explore' }) }],
      } as ModelMessage,
      { role: 'system', content: '<post-tool-failure-hook>\nTask execution failed\n</post-tool-failure-hook>' },
      { role: 'tool', content: 'Task execution failed: Unknown error', toolCallId: 'call_00' } as ModelMessage,
      { role: 'system', content: '<auto-continuation>请继续</auto-continuation>' },
    ];

    const ai = await captureAiMessages(messages);
    expect(() => assertAiSdkToolPairing(ai)).not.toThrow();
  });

  it('并行多 tool-call（call_00 + call_01）夹 system：两个结果都紧跟 assistant，不触发 MissingToolResults', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'do two things' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_00', name: 'Task', arguments: JSON.stringify({ subagent_type: 'explore' }) },
          { id: 'call_01', name: 'Task', arguments: JSON.stringify({ subagent_type: 'general' }) },
        ],
      } as ModelMessage,
      { role: 'tool', content: 'result 0', toolCallId: 'call_00' } as ModelMessage,
      { role: 'system', content: '<post-tool-hook>note</post-tool-hook>' },
      { role: 'tool', content: 'result 1', toolCallId: 'call_01' } as ModelMessage,
    ];

    const ai = await captureAiMessages(messages);
    expect(() => assertAiSdkToolPairing(ai)).not.toThrow();
  });

  it('已正确排序（assistant → tool → system）：保持有效，不回归', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_00', name: 'Task', arguments: '{}' }],
      } as ModelMessage,
      { role: 'tool', content: 'ok', toolCallId: 'call_00' } as ModelMessage,
      { role: 'system', content: 'reminder' },
    ];

    const ai = await captureAiMessages(messages);
    expect(() => assertAiSdkToolPairing(ai)).not.toThrow();
  });
});
