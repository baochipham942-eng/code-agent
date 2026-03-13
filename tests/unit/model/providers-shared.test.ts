// ============================================================================
// Provider Shared Utilities — Pure Function Unit Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  convertToOpenAIMessages,
  convertToClaudeMessages,
  normalizeJsonSchema,
  convertToolsToOpenAI,
  convertToolsToClaude,
} from '../../../src/main/model/providers/shared';
import type { ModelMessage } from '../../../src/main/model/types';
import type { ToolDefinition } from '../../../src/shared/types';

// ----------------------------------------------------------------------------
// Type helpers for test assertions
// ----------------------------------------------------------------------------

/** Convenience alias so we can access nested schema properties without `unknown` errors. */
interface SchemaNode {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  [key: string]: unknown;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTextMessage(role: string, content: string): ModelMessage {
  return { role, content };
}

function makeAssistantWithToolCalls(
  content: string | null,
  toolCalls: { id: string; name: string; arguments: string }[],
): ModelMessage {
  return {
    role: 'assistant',
    content: content ?? '',
    toolCalls,
  };
}

function makeToolResult(toolCallId: string, content: string, toolError = false): ModelMessage {
  return {
    role: 'tool',
    content,
    toolCallId,
    toolError,
  };
}

function makeImageMessage(): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANS',
        },
      },
    ],
  };
}

function makeTool(name: string, desc: string, schema: any): ToolDefinition {
  return {
    name,
    description: desc,
    inputSchema: schema,
    permissionLevel: 'read',
  } as ToolDefinition;
}

// ============================================================================
// convertToOpenAIMessages
// ============================================================================

describe('convertToOpenAIMessages', () => {
  it('converts text-only user message', () => {
    const messages: ModelMessage[] = [
      makeTextMessage('user', 'Hello world'),
    ];
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello world' });
  });

  it('converts assistant message with tool_calls', () => {
    const messages: ModelMessage[] = [
      makeAssistantWithToolCalls('Let me search', [
        { id: 'tc_1', name: 'web_search', arguments: '{"query":"vitest"}' },
      ]),
      makeToolResult('tc_1', 'Search results here'),
    ];
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(2);
    // assistant message
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('Let me search');
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls[0]).toEqual({
      id: 'tc_1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"vitest"}' },
    });
    // tool response
    expect(result[1]).toEqual({
      role: 'tool',
      tool_call_id: 'tc_1',
      content: 'Search results here',
    });
  });

  it('converts tool result with correct tool_call_id', () => {
    const messages: ModelMessage[] = [
      makeAssistantWithToolCalls('', [
        { id: 'call_abc', name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
        { id: 'call_def', name: 'read_file', arguments: '{"path":"/tmp/b.txt"}' },
      ]),
      makeToolResult('call_abc', 'content of a'),
      makeToolResult('call_def', 'content of b'),
    ];
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(3);
    expect(result[1].tool_call_id).toBe('call_abc');
    expect(result[1].content).toBe('content of a');
    expect(result[2].tool_call_id).toBe('call_def');
    expect(result[2].content).toBe('content of b');
  });

  it('handles multimodal image content', () => {
    const messages: ModelMessage[] = [makeImageMessage()];
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(result[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANS' },
    });
  });

  it('sanitizes dangling tool results by synthesizing placeholders', () => {
    // Simulate compaction scenario: assistant has tool_calls but responses were removed
    const messages: ModelMessage[] = [
      makeAssistantWithToolCalls('', [
        { id: 'orphan_1', name: 'bash', arguments: '{"cmd":"ls"}' },
      ]),
      // No tool result for orphan_1 — jump to next user message
      makeTextMessage('user', 'What happened?'),
    ];
    const result = convertToOpenAIMessages(messages);

    // Should synthesize a placeholder tool response between assistant and user
    const toolMessages = result.filter((m: any) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe('orphan_1');
    expect(toolMessages[0].content).toBe('[context compacted]');

    // Order: assistant → tool(placeholder) → user
    const roles = result.map((m: any) => m.role);
    const assistantIdx = roles.indexOf('assistant');
    const toolIdx = roles.indexOf('tool');
    const userIdx = roles.lastIndexOf('user');
    expect(toolIdx).toBeGreaterThan(assistantIdx);
    expect(userIdx).toBeGreaterThan(toolIdx);
  });
});

// ============================================================================
// convertToClaudeMessages
// ============================================================================

describe('convertToClaudeMessages', () => {
  it('converts system + user + assistant sequence', () => {
    const messages: ModelMessage[] = [
      makeTextMessage('system', 'You are helpful.'),
      makeTextMessage('user', 'Hi'),
      makeTextMessage('assistant', 'Hello!'),
    ];
    const result = convertToClaudeMessages(messages);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(result[1]).toEqual({ role: 'user', content: 'Hi' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'Hello!' });
  });

  it('handles tool_use blocks in assistant messages', () => {
    const messages: ModelMessage[] = [
      makeAssistantWithToolCalls('Thinking...', [
        { id: 'tu_1', name: 'bash', arguments: '{"command":"pwd"}' },
      ]),
    ];
    const result = convertToClaudeMessages(messages);

    // sanitizeClaudeToolPairing synthesizes a placeholder tool_result for orphaned tool_use
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: 'text', text: 'Thinking...' });
    expect(result[0].content[1]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'bash',
      input: { command: 'pwd' },
    });
    // Synthesized placeholder
    expect(result[1].role).toBe('user');
    expect(result[1].content).toHaveLength(1);
    expect(result[1].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '[context compacted]',
    });
  });

  it('handles tool_result blocks and merges consecutive ones', () => {
    const messages: ModelMessage[] = [
      makeAssistantWithToolCalls('', [
        { id: 'tu_a', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tu_b', name: 'read', arguments: '{"path":"b.ts"}' },
      ]),
      makeToolResult('tu_a', 'file a content'),
      makeToolResult('tu_b', 'file b content'),
    ];
    const result = convertToClaudeMessages(messages);

    // assistant(tool_use blocks) + user(merged tool_results)
    expect(result).toHaveLength(2);

    // The tool_result messages should be merged into a single user message
    const userMsg = result[1];
    expect(userMsg.role).toBe('user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_a',
      content: 'file a content',
    });
    expect(userMsg.content[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_b',
      content: 'file b content',
    });
  });

  it('marks failed tool_result blocks with is_error for Claude', () => {
    const messages: ModelMessage[] = [
      makeAssistantWithToolCalls('', [
        { id: 'tu_err', name: 'web_search', arguments: '{"query":"latest ai"}' },
      ]),
      makeToolResult('tu_err', 'Brave Search API error (429)', true),
    ];
    const result = convertToClaudeMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('user');
    expect(Array.isArray(result[1].content)).toBe(true);
    expect(result[1].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_err',
      content: 'Brave Search API error (429)',
      is_error: true,
    });
  });
});

// ============================================================================
// normalizeJsonSchema
// ============================================================================

describe('normalizeJsonSchema', () => {
  it('removes unsupported properties by adding additionalProperties: false', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    };
    const result = normalizeJsonSchema(schema) as SchemaNode;

    expect(result.additionalProperties).toBe(false);
    expect(result.properties!.name).toEqual({ type: 'string' });
    expect(result.required).toEqual(['name']);
  });

  it('handles nested object schemas recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
        },
      },
    };
    const result = normalizeJsonSchema(schema) as SchemaNode;

    // Top-level
    expect(result.additionalProperties).toBe(false);
    // Nested
    expect(result.properties!.address.additionalProperties).toBe(false);
    expect(result.properties!.address.properties!.street).toEqual({ type: 'string' });
  });

  it('handles array schemas with item normalization', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
        },
      },
    };
    const result = normalizeJsonSchema(schema) as SchemaNode;

    expect(result.items!.additionalProperties).toBe(false);
    expect(result.items!.properties!.id).toEqual({ type: 'number' });
  });

  it('returns non-object input unchanged', () => {
    expect(normalizeJsonSchema(null)).toBeNull();
    expect(normalizeJsonSchema(undefined)).toBeUndefined();
    expect(normalizeJsonSchema('string' as unknown as Record<string, unknown>)).toBe('string');
  });
});

// ============================================================================
// convertToolsToOpenAI
// ============================================================================

describe('convertToolsToOpenAI', () => {
  it('converts ToolDefinition array to OpenAI function format', () => {
    const tools: ToolDefinition[] = [
      makeTool('bash', 'Run a command', {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command' },
        },
        required: ['command'],
      }),
    ];
    const result = convertToolsToOpenAI(tools);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('function');
    expect(result[0].function.name).toBe('bash');
    expect(result[0].function.description).toBe('Run a command');
    // Schema should be normalized (additionalProperties: false)
    const params = result[0].function.parameters as SchemaNode;
    expect(params.additionalProperties).toBe(false);
    expect(params.properties!.command).toEqual({
      type: 'string',
      description: 'The command',
    });
  });

  it('includes strict flag when requested', () => {
    const tools: ToolDefinition[] = [
      makeTool('test', 'A test tool', { type: 'object', properties: {} }),
    ];
    const result = convertToolsToOpenAI(tools, true);

    expect(result[0].function.strict).toBe(true);
  });
});

// ============================================================================
// convertToolsToClaude
// ============================================================================

describe('convertToolsToClaude', () => {
  it('converts ToolDefinition array to Claude format', () => {
    const inputSchema = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const tools: ToolDefinition[] = [
      makeTool('search', 'Search the web', inputSchema),
    ];
    const result = convertToolsToClaude(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'search',
      description: 'Search the web',
      input_schema: inputSchema,
    });
  });
});
