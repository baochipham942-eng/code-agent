import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import { selectGuestChannelAllowedToolNames } from '../../../src/host/channels/channelGuestToolPolicy';

function tool(
  name: string,
  permissionLevel: ToolDefinition['permissionLevel'] = 'read',
  source?: ToolDefinition['source'],
): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'string' },
    requiresPermission: permissionLevel !== 'read',
    permissionLevel,
    source,
  };
}

describe('guest channel tool policy', () => {
  it('keeps read-only conversation helpers and removes every forbidden capability family', () => {
    const visible = selectGuestChannelAllowedToolNames([
      tool('Read'),
      tool('Grep'),
      tool('AskUserQuestion'),
      tool('Bash', 'execute'),
      tool('BrowserNavigate'),
      tool('ComputerUse'),
      tool('Write', 'write'),
      tool('mcp__lark__send_message', 'read', 'mcp'),
      tool('CronCreate'),
      tool('delegate_task'),
      tool('spawn_agent'),
    ]);

    expect(visible).toEqual(['Read', 'Grep', 'AskUserQuestion']);
    expect(visible).not.toEqual(expect.arrayContaining([
      'Bash', 'BrowserNavigate', 'ComputerUse', 'Write', 'mcp__lark__send_message',
      'CronCreate', 'delegate_task', 'spawn_agent',
    ]));
  });
});
