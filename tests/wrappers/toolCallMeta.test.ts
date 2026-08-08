import { describe, expect, it } from 'vitest';

import { buildToolCallFromAccumulator, handleGeminiStream } from '../../src/host/model/providers/shared';
import { parseClaudeResponse } from '../../src/host/model/providers/wrappers/anthropicWrapper';
import { parseGeminiResponse } from '../../src/host/model/providers/wrappers/geminiWrapper';
import { parseOpenAIResponse } from '../../src/host/model/providers/wrappers/openaiWrapper';

const metaShapes: Array<{ name: string; value: unknown; semantic?: boolean }> = [
  {
    name: 'plain object',
    value: {
      shortDescription: '派发研究任务',
      targetContext: { kind: 'app', label: 'Agent Neo' },
      expectedOutcome: '后台任务开始',
    },
    semantic: true,
  },
  { name: 'string', value: 'bad meta' },
  { name: 'array', value: ['bad meta'] },
  { name: 'null', value: null },
];

function expectStripped(toolCall: {
  arguments: Record<string, unknown>;
  shortDescription?: string;
  expectedOutcome?: string;
}, semantic = false): void {
  expect(toolCall.arguments).toEqual({ task: 'research' });
  expect(toolCall.arguments).not.toHaveProperty('_meta');
  if (semantic) {
    expect(toolCall.shortDescription).toBe('派发研究任务');
    expect(toolCall.expectedOutcome).toBe('后台任务开始');
  } else {
    expect(toolCall.expectedOutcome).toBeUndefined();
  }
}

describe.each(metaShapes)('tool-call _meta chokepoint / $name', ({ value, semantic }) => {
  it('strips _meta from streaming accumulator output', () => {
    const result = buildToolCallFromAccumulator({
      id: 'stream-1',
      name: 'delegate_task',
      arguments: JSON.stringify({ task: 'research', _meta: value }),
    });
    expectStripped(result, semantic);
  });

  it('strips _meta from non-streaming OpenAI output', () => {
    const result = parseOpenAIResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'openai-1',
            type: 'function',
            function: {
              name: 'delegate_task',
              arguments: JSON.stringify({ task: 'research', _meta: value }),
            },
          }],
        },
      }],
    });
    expectStripped(result.toolCalls![0], semantic);
  });

  it('strips _meta from non-streaming Anthropic output', () => {
    const result = parseClaudeResponse({
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'claude-1',
        name: 'delegate_task',
        input: { task: 'research', _meta: value },
      }],
    });
    expectStripped(result.toolCalls![0], semantic);
  });

  it('strips _meta from non-streaming Gemini output', () => {
    const result = parseGeminiResponse({
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: 'delegate_task',
              args: { task: 'research', _meta: value },
            },
          }],
        },
      }],
    });
    expectStripped(result.toolCalls![0], semantic);
  });

  it('strips _meta from streaming Gemini output', async () => {
    const payload = JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: 'delegate_task',
              args: { task: 'research', _meta: value },
            },
          }],
        },
      }],
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n`));
        controller.close();
      },
    });
    const result = await handleGeminiStream(body, () => undefined);
    expect(result.type).toBe('tool_use');
    expectStripped(result.toolCalls![0], semantic);
  });
});
