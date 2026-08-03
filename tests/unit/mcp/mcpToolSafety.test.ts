import { describe, expect, it } from 'vitest';
import {
  classifyMcpToolReplaySafety,
  isMcpToolReadOnly,
} from '../../../src/host/mcp/mcpToolSafety';

describe('MCP tool safety', () => {
  it('uses one conservative read-only predicate', () => {
    expect(isMcpToolReadOnly({ readOnlyHint: true })).toBe(true);
    expect(isMcpToolReadOnly({ readOnlyHint: true, destructiveHint: true })).toBe(false);
    expect(isMcpToolReadOnly(undefined)).toBe(false);
  });

  it('allows replay only for explicit read-only or idempotent tools', () => {
    expect(classifyMcpToolReplaySafety({ readOnlyHint: true })).toBe('automatic');
    expect(classifyMcpToolReplaySafety({ idempotentHint: true })).toBe('automatic');
    expect(classifyMcpToolReplaySafety(undefined)).toBe('unknown');
    expect(classifyMcpToolReplaySafety({})).toBe('unknown');
  });

  it('gives destructiveHint precedence over conflicting safe hints', () => {
    expect(classifyMcpToolReplaySafety({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: true,
    })).toBe('forbidden');
  });
});
