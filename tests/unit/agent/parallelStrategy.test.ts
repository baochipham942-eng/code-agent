import { describe, expect, it } from 'vitest';
import { classifyToolCalls, isParallelSafeTool } from '../../../src/host/agent/toolExecution/parallelStrategy';

describe('MCP parallel safety', () => {
  it.each(['mcp__x__delete', 'mcp__k8s__apply', 'mcp__x__read'])('keeps unannotated %s sequential', (name) => {
    const call = { id: 'call-1', name, arguments: {} };
    expect(classifyToolCalls([call])).toEqual({
      parallelGroup: [], sequentialGroup: [{ index: 0, toolCall: call }],
    });
  });

  it('requires explicit read-only annotations and respects destructive hints', () => {
    expect(isParallelSafeTool('mcp__x__read', {})).toBe(false);
    expect(isParallelSafeTool('mcp__x__read', { readOnlyHint: true })).toBe(true);
    expect(isParallelSafeTool('mcp__x__read', { readOnlyHint: true, destructiveHint: true })).toBe(false);
  });
});


it('classifies three registered Read calls as parallel', () => {
  const calls = [1, 2, 3].map(id => ({ id: String(id), name: 'Read', arguments: { file_path: `${id}.txt` } }));
  expect(classifyToolCalls(calls).parallelGroup).toHaveLength(3);
  expect(classifyToolCalls(calls).sequentialGroup).toEqual([]);
});

it('keeps reads after a write in order instead of hoisting them into the parallel group', () => {
  const call = (id: string, name: string, file_path: string) => ({ id, name, arguments: { file_path } });
  const mixed = classifyToolCalls([call('1', 'Write', 'a.txt'), call('2', 'Read', 'a.txt')]);
  expect(mixed.parallelGroup).toEqual([]);
  expect(mixed.sequentialGroup.map((entry) => entry.toolCall.name)).toEqual(['Write', 'Read']);

  const prefix = classifyToolCalls([
    call('1', 'Read', 'a.txt'), call('2', 'Read', 'b.txt'), call('3', 'Write', 'a.txt'), call('4', 'Read', 'a.txt'),
  ]);
  expect(prefix.parallelGroup.map((entry) => entry.index)).toEqual([0, 1]);
  expect(prefix.sequentialGroup.map((entry) => entry.index)).toEqual([2, 3]);
});
