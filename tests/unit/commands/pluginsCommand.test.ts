import { describe, expect, it, vi } from 'vitest';
import { pluginsCommand } from '../../../src/shared/commands/definitions/newCommands';
import type { CommandContext } from '../../../src/shared/commands/types';

function makeContext(extensionOps?: unknown): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  return {
    output,
    ctx: {
      surface: 'gui',
      extensionOps,
      output: {
        info: (msg) => output.push(msg),
        success: (msg) => output.push(`success:${msg}`),
        error: (msg) => output.push(`error:${msg}`),
        warn: (msg) => output.push(`warn:${msg}`),
      },
    },
  };
}

describe('pluginsCommand', () => {
  it('uses injected extension operations on GUI surface', async () => {
    const extensionOps = {
      list: vi.fn(async () => [
        {
          id: 'browser-control',
          name: 'Browser Control',
          type: 'plugin',
          status: 'active',
          source: 'builtin',
          version: '1.0.0',
        },
        {
          id: 'docx@local',
          name: 'docx',
          type: 'skill',
          status: 'disabled',
          source: 'marketplace',
        },
      ]),
      install: vi.fn(),
      uninstall: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      reload: vi.fn(),
      validate: vi.fn(),
    };
    const { ctx, output } = makeContext(extensionOps);

    const result = await pluginsCommand.handler(ctx, []);

    expect(result).toEqual({ success: true, data: { count: 2 } });
    expect(extensionOps.list).toHaveBeenCalledTimes(1);
    expect(output.join('\n')).toContain('Extensions (2)');
    expect(output.join('\n')).toContain('browser-control  plugin  active v1.0.0 [builtin]');
    expect(output.join('\n')).toContain('docx@local  skill  disabled [marketplace]');
  });

  it('reports a GUI wiring error instead of importing main services in renderer', async () => {
    const { ctx, output } = makeContext();

    const result = await pluginsCommand.handler(ctx, []);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Extension operations are not wired for GUI commands');
    expect(output.join('\n')).toContain('Plugin operation failed: Extension operations are not wired for GUI commands');
  });
});
