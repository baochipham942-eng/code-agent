import { describe, expect, it } from 'vitest';

import { buildCuaAgentCursorCapabilityForToolCall } from '../../../src/host/mcp/cuaAgentCursor';

describe('cuaAgentCursor capability bridge', () => {
  it('falls back to renderer cursor when CUA is disabled', () => {
    expect(buildCuaAgentCursorCapabilityForToolCall({
      serverName: 'cua-driver',
      toolName: 'get_agent_cursor_state',
      success: true,
      env: {},
      platform: 'darwin',
      checkedAtMs: 10,
    })).toMatchObject({
      enabled: false,
      status: 'fallback',
      provider: 'renderer',
      supportsSystemOverlay: false,
      reason: 'cua_disabled',
      fallbackSurface: 'renderer',
      checkedAtMs: 10,
    });
  });

  it('does not claim a native cursor on unsupported platforms', () => {
    expect(buildCuaAgentCursorCapabilityForToolCall({
      serverName: 'cua-driver',
      toolName: 'get_agent_cursor_state',
      success: true,
      env: { CODE_AGENT_ENABLE_CUA: '1' },
      platform: 'linux',
    })).toMatchObject({
      enabled: false,
      status: 'unavailable',
      provider: 'none',
      supportsSystemOverlay: false,
      fallbackSurface: 'renderer',
    });
  });

  it('marks the native CUA agent cursor as available only after a successful cursor lifecycle tool call', () => {
    expect(buildCuaAgentCursorCapabilityForToolCall({
      serverName: 'cua-driver',
      toolName: 'get_agent_cursor_state',
      success: true,
      env: { CODE_AGENT_ENABLE_CUA: '1' },
      platform: 'darwin',
      checkedAtMs: 20,
    })).toMatchObject({
      enabled: true,
      status: 'native',
      provider: 'cua-driver',
      supportsSystemOverlay: true,
      reason: 'get_agent_cursor_state_available',
      fallbackSurface: null,
      checkedAtMs: 20,
    });
  });

  it('keeps ordinary CUA actions on renderer fallback until native cursor state is confirmed', () => {
    expect(buildCuaAgentCursorCapabilityForToolCall({
      serverName: 'cua-driver',
      toolName: 'click',
      success: true,
      env: { CODE_AGENT_ENABLE_CUA: '1' },
      platform: 'darwin',
    })).toMatchObject({
      enabled: false,
      status: 'fallback',
      provider: 'renderer',
      supportsSystemOverlay: false,
      reason: 'native_cursor_not_confirmed',
    });
  });
});
