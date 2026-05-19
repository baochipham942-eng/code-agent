import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/shared/commands';
import {
  connectorsCommand,
  mcpCommand,
  skillsCommand,
} from '../../../src/shared/commands/definitions/toolsCommands';

function makeCtx(overrides: Partial<CommandContext> = {}) {
  const messages: string[] = [];
  const ctx: CommandContext = {
    surface: 'gui',
    output: {
      info: (msg) => messages.push(msg),
      success: (msg) => messages.push(msg),
      warn: (msg) => messages.push(msg),
      error: (msg) => messages.push(msg),
    },
    ...overrides,
  };
  return { ctx, messages };
}

describe('tools slash commands', () => {
  it('lists available, mounted, and selected skills from GUI ops', async () => {
    const { ctx, messages } = makeCtx({
      skillOps: {
        listAvailable: vi.fn(async () => [
          { name: 'docx', description: 'Word docs', basePath: '/skills/docx', source: 'user', aliases: [], allowedTools: [], loaded: false, promptContent: '', disableModelInvocation: false, userInvocable: true, executionContext: 'inline' },
          { name: 'excel', description: 'Excel sheets', basePath: '/skills/excel', source: 'user', aliases: [], allowedTools: [], loaded: false, promptContent: '', disableModelInvocation: false, userInvocable: true, executionContext: 'inline' },
        ]),
        listMounted: vi.fn(async () => [
          { skillName: 'docx', libraryId: 'user', mountedAt: 1, source: 'manual' },
        ]),
        listSelected: vi.fn(() => ['excel']),
      },
    });

    const result = await skillsCommand.handler(ctx, []);

    expect(result.success).toBe(true);
    expect(messages.join('\n')).toContain('Skills (2 available, 1 mounted, 1 selected)');
    expect(messages.join('\n')).toContain('Selected: excel');
    expect(messages.join('\n')).toContain('Mounted: docx');
  });

  it('lists MCP server state from GUI ops', async () => {
    const { ctx, messages } = makeCtx({
      mcpOps: {
        getStatus: vi.fn(async () => ({ connected: true, connectedServers: ['github'], inProcessServers: [], toolCount: 2, resourceCount: 0 })),
        listServerStates: vi.fn(async () => [
          { config: { name: 'github', enabled: true, type: 'stdio' }, status: 'connected', toolCount: 2, resourceCount: 0 },
        ]),
        listTools: vi.fn(async () => [
          { name: 'mcp__github__search', description: 'Search', serverName: 'github' },
        ]),
      },
    });

    const result = await mcpCommand.handler(ctx, []);

    expect(result.success).toBe(true);
    expect(messages.join('\n')).toContain('MCP (1 servers, 1 tools)');
    expect(messages.join('\n')).toContain('+ github  connected/enabled');
  });

  it('lists connector status from GUI ops', async () => {
    const { ctx, messages } = makeCtx({
      connectorOps: {
        listStatuses: vi.fn(async () => [
          { id: 'mail', label: 'Mail', connected: true, readiness: 'ready', capabilities: ['mail_search'] },
          { id: 'calendar', label: 'Calendar', connected: false, readiness: 'failed', error: 'no permission', capabilities: ['calendar_list'] },
        ]),
        listSelected: vi.fn(() => ['calendar']),
      },
    });

    const result = await connectorsCommand.handler(ctx, []);

    expect(result.success).toBe(true);
    expect(messages.join('\n')).toContain('Connectors (2 total, 1 selected)');
    expect(messages.join('\n')).toContain('mail  Mail ready');
    expect(messages.join('\n')).toContain('calendar  Calendar selected failed (no permission)');
  });
});
