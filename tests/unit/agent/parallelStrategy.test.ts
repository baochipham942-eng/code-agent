import { describe, expect, it } from 'vitest';
import { classifyToolCalls } from '../../../src/host/agent/toolExecution/parallelStrategy';
import type { MCPToolAnnotations } from '../../../src/host/mcp/types';
import type { ToolCall } from '../../../src/shared/contract';

const ROOT = '/tmp/toolres-k2';
const options = { workspace: ROOT, cwd: ROOT };

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

function names(toolCalls: ToolCall[], annotations?: Map<string, MCPToolAnnotations>): string[][] {
  return classifyToolCalls(toolCalls, annotations, options)
    .segments.map((segment) => segment.map((entry) => entry.toolCall.name));
}

describe('MCP parallel safety', () => {
  it.each(['mcp__x__delete', 'mcp__k8s__apply', 'mcp__x__read'])('keeps unannotated %s in its own segment', (name) => {
    const toolCall = call('call-1', name);
    expect(classifyToolCalls([toolCall], undefined, options)).toEqual({
      segments: [[{ index: 0, toolCall }]],
      deferred: [],
    });
    expect(names([toolCall, call('2', 'Read', { file_path: 'a.txt' })])).toEqual([[name], ['Read']]);
  });

  it('shares a segment only for an explicit read-only MCP annotation', () => {
    const read = call('2', 'Read', { file_path: 'a.txt' });
    const mcp = call('1', 'mcp__x__read');
    expect(names([mcp, read], new Map([[mcp.name, { readOnlyHint: true }]]))).toEqual([['mcp__x__read', 'Read']]);
    expect(names([mcp, read], new Map([[mcp.name, {}]]))).toEqual([['mcp__x__read'], ['Read']]);
    expect(names([mcp, read], new Map([[mcp.name, { readOnlyHint: true, destructiveHint: true }]]))).toEqual([
      ['mcp__x__read'],
      ['Read'],
    ]);
  });
});

it('classifies three reads of different files as one segment', () => {
  const calls = [1, 2, 3].map((id) => call(String(id), 'Read', { file_path: `${id}.txt` }));
  const classified = classifyToolCalls(calls, undefined, options);
  expect(classified.segments).toHaveLength(1);
  expect(classified.segments[0]).toHaveLength(3);
  expect(classified.deferred).toEqual([]);
});

it('keeps a same-path read after the write instead of hoisting it', () => {
  expect(names([
    call('1', 'Write', { file_path: 'a.txt', content: 'x' }),
    call('2', 'Read', { file_path: 'a.txt' }),
  ])).toEqual([['Write'], ['Read']]);

  const prefix = classifyToolCalls([
    call('1', 'Read', { file_path: 'a.txt' }),
    call('2', 'Read', { file_path: 'b.txt' }),
    call('3', 'Write', { file_path: 'a.txt', content: 'x' }),
    call('4', 'Read', { file_path: 'a.txt' }),
  ], undefined, options);
  expect(prefix.segments.map((segment) => segment.map((entry) => entry.index))).toEqual([[0, 1], [2], [3]]);
});

it('splits Task from Read in either order and keeps Task fan-out in one segment', () => {
  expect(names([
    call('1', 'Task', { subagent_type: 'coder' }),
    call('2', 'Read', { file_path: 'a.txt' }),
  ])).toEqual([['Task'], ['Read']]);
  expect(names([
    call('1', 'Read', { file_path: 'a.txt' }),
    call('2', 'Task', { subagent_type: 'coder' }),
  ])).toEqual([['Read'], ['Task']]);
  expect(names([
    call('1', 'Task', { subagent_type: 'coder' }),
    call('2', 'Task', { subagent_type: 'reviewer' }),
  ])).toEqual([['Task', 'Task']]);
});
