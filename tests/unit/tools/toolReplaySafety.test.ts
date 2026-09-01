import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import {
  canAutomaticallyReplayTool,
  classifyToolReplaySafety,
} from '../../../src/host/tools/toolReplaySafety';

function nativeDefinition(input: {
  name?: string;
  readOnly: boolean;
  permissionLevel: ToolDefinition['permissionLevel'];
}): ToolDefinition {
  return {
    name: input.name ?? 'NativeProbe',
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'string' },
    requiresPermission: input.permissionLevel !== 'read',
    permissionLevel: input.permissionLevel,
    readOnly: input.readOnly,
  };
}

function mcpDefinition(annotations?: {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}): ToolDefinition {
  return {
    ...nativeDefinition({ readOnly: false, permissionLevel: 'network' }),
    name: 'mcp__fixture__probe',
    metadata: { annotations },
  } as ToolDefinition;
}

describe('classifyToolReplaySafety', () => {
  it.each([
    { readOnly: true, permissionLevel: 'read' as const, expected: 'automatic' },
    { readOnly: true, permissionLevel: 'write' as const, expected: 'unknown' },
    { readOnly: false, permissionLevel: 'read' as const, expected: 'unknown' },
    { readOnly: false, permissionLevel: 'write' as const, expected: 'unknown' },
  ])('classifies the native readOnly/sideEffect quadrant %#', (fixture) => {
    expect(classifyToolReplaySafety(nativeDefinition(fixture))).toBe(fixture.expected);
  });

  it.each([
    { annotations: { readOnlyHint: true }, expected: 'automatic' },
    { annotations: { idempotentHint: true }, expected: 'automatic' },
    { annotations: { destructiveHint: true, readOnlyHint: true }, expected: 'forbidden' },
    { annotations: undefined, expected: 'unknown' },
  ])('reuses the MCP replay classifier %#', ({ annotations, expected }) => {
    expect(classifyToolReplaySafety(mcpDefinition(annotations))).toBe(expected);
  });

  it('forbids the external side-effect allowlist even if readOnly is misdeclared', () => {
    expect(classifyToolReplaySafety(nativeDefinition({
      name: 'mail_send',
      readOnly: true,
      permissionLevel: 'read',
    }))).toBe('forbidden');
  });

  it('requires stored and current declarations to both remain automatic', () => {
    expect(canAutomaticallyReplayTool('automatic', 'automatic')).toBe(true);
    expect(canAutomaticallyReplayTool('unknown', 'automatic')).toBe(false);
    expect(canAutomaticallyReplayTool('automatic', 'unknown')).toBe(false);
    expect(canAutomaticallyReplayTool('automatic', 'forbidden')).toBe(false);
  });
});
