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
