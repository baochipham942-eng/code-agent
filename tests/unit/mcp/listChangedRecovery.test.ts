import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { McpSubscription, Tool } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpListChangedRecovery } from '../../../src/host/mcp/mcpListChangedRecovery';

const FILTER = { toolsListChanged: true };

function subscription(reason: 'local' | 'graceful' | 'remote'): McpSubscription {
  return {
    honoredFilter: FILTER,
    close: vi.fn(async () => {}),
    closed: Promise.resolve(reason),
  };
}

function callbacks(applyTools: (tools: Tool[]) => void = () => {}) {
  return {
    shouldContinue: () => true,
    applyTools,
    applyResources: vi.fn(),
    applyPrompts: vi.fn(),
  };
}

describe('MCP listChanged subscription recovery', () => {
  it('restores notification flow after the original subscription is interrupted', async () => {
    const visibleTools = ['old_tool'];
    const applyTools = (tools: Tool[]) => {
      visibleTools.splice(0, visibleTools.length, ...tools.map((tool) => tool.name));
    };
    const listen = vi.fn(async () => {
      applyTools([
        { name: 'old_tool', inputSchema: { type: 'object' } },
        { name: 'new_tool', inputSchema: { type: 'object' } },
      ]);
      return subscription('local');
    });
    const recovery = new McpListChangedRecovery(async () => {});

    await recovery.monitor('fixture', {
      autoOpenedSubscription: subscription('remote'),
      listen,
    } as never, callbacks(applyTools));

    expect(listen).toHaveBeenCalledWith(FILTER);
    expect(visibleTools).toEqual(['old_tool', 'new_tool']);
  });

  it('falls back to TTL refresh after bounded relisten failures', async () => {
    const listen = vi.fn(async () => {
      throw new Error('server still unavailable');
    });
    const recovery = new McpListChangedRecovery(async () => {});

    await recovery.monitor('fixture', {
      autoOpenedSubscription: subscription('graceful'),
      listen,
    } as never, callbacks());

    expect(listen).toHaveBeenCalledTimes(3);
    recovery.stop('fixture');
  });

  it('treats listen on a legacy protocol as normal and keeps unsolicited notifications', async () => {
    const listen = vi.fn(async () => {
      throw new SdkError(
        SdkErrorCode.MethodNotSupportedByProtocolVersion,
        'legacy protocol',
      );
    });
    const recovery = new McpListChangedRecovery(async () => {});

    await recovery.monitor('legacy-fixture', {
      autoOpenedSubscription: subscription('remote'),
      listen,
    } as never, callbacks());

    expect(listen).toHaveBeenCalledOnce();
  });
});
