import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { McpSubscription } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { maintainListChangedSubscription } from '../../../src/host/mcp/mcpListChangedRecovery';

const FILTER = { tools: {} };

function subscription(reason: 'local' | 'graceful' | 'remote'): McpSubscription {
  return {
    honoredFilter: FILTER,
    close: vi.fn(async () => {}),
    closed: Promise.resolve(reason),
  };
}

describe('MCP listChanged subscription recovery', () => {
  it('restores notification flow after the original subscription is interrupted', async () => {
    const visibleTools = ['old_tool'];
    const onToolsChanged = (tools: string[]) => visibleTools.splice(0, visibleTools.length, ...tools);
    const listen = vi.fn(async () => {
      onToolsChanged(['old_tool', 'new_tool']);
      return subscription('local');
    });

    await maintainListChangedSubscription({
      serverName: 'fixture',
      client: { listen },
      initialSubscription: subscription('remote'),
      shouldContinue: () => true,
      onUnavailable: vi.fn(),
      sleep: async () => {},
    });

    expect(listen).toHaveBeenCalledWith(FILTER);
    expect(visibleTools).toEqual(['old_tool', 'new_tool']);
  });

  it('falls back to TTL refresh after bounded relisten failures', async () => {
    const onUnavailable = vi.fn();
    const listen = vi.fn(async () => {
      throw new Error('server still unavailable');
    });

    await maintainListChangedSubscription({
      serverName: 'fixture',
      client: { listen },
      initialSubscription: subscription('graceful'),
      shouldContinue: () => true,
      onUnavailable,
      sleep: async () => {},
    });

    expect(listen).toHaveBeenCalledTimes(3);
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('treats listen on a legacy protocol as normal and keeps unsolicited notifications', async () => {
    const onUnavailable = vi.fn();
    const listen = vi.fn(async () => {
      throw new SdkError(
        SdkErrorCode.MethodNotSupportedByProtocolVersion,
        'legacy protocol',
      );
    });

    await maintainListChangedSubscription({
      serverName: 'legacy-fixture',
      client: { listen },
      initialSubscription: subscription('remote'),
      shouldContinue: () => true,
      onUnavailable,
      sleep: async () => {},
    });

    expect(listen).toHaveBeenCalledOnce();
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
