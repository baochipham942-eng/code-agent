import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../../../../src/shared/commands/commandRegistry';
import type { CommandContext, CommandDefinition } from '../../../../src/shared/commands/types';

describe('CommandRegistry', () => {
  const ctx: CommandContext = {
    surface: 'cli',
    output: {
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  };

  function command(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
    return {
      id: 'run',
      name: 'Run',
      description: 'Run a task',
      category: 'system',
      surfaces: ['cli'],
      aliases: ['r'],
      handler: vi.fn(async (_ctx, args) => ({ success: true, data: { args } })),
      ...overrides,
    };
  }

  it('registers commands, resolves aliases, and filters by surface', () => {
    const registry = new CommandRegistry();
    const run = command();
    const guiOnly = command({
      id: 'inspect',
      name: 'Inspect',
      description: 'Inspect state',
      surfaces: ['gui'],
      aliases: ['i'],
    });

    registry.register(run);
    registry.register(guiOnly);

    expect(registry.get('run')).toBe(run);
    expect(registry.get('r')).toBe(run);
    expect(registry.list('cli')).toEqual([run]);
    expect(registry.list('gui')).toEqual([guiOnly]);
  });

  it('rejects duplicate command ids and alias collisions', () => {
    const registry = new CommandRegistry();
    registry.register(command());

    expect(() => registry.register(command({ aliases: [] }))).toThrow('Command already registered: /run');
    expect(() => registry.register(command({ id: 'other', aliases: ['r'] }))).toThrow(
      'Alias /r is already registered to /run',
    );
    expect(() => registry.register(command({ id: 'other', aliases: ['run'] }))).toThrow(
      'Alias /run conflicts with command id /run',
    );
    expect(() => registry.register(command({ id: 'r', aliases: [] }))).toThrow(
      'Command id /r conflicts with alias for /run',
    );
  });

  it('searches id, name, and description within an optional surface', () => {
    const registry = new CommandRegistry();
    const run = command({ description: 'Execute automation' });
    const inspect = command({
      id: 'inspect',
      name: 'Inspect',
      description: 'Look at state',
      surfaces: ['gui'],
      aliases: [],
    });

    registry.register(run);
    registry.register(inspect);

    expect(registry.search('auto')).toEqual([run]);
    expect(registry.search('inspect', 'cli')).toEqual([]);
    expect(registry.search('inspect', 'gui')).toEqual([inspect]);
  });

  it('executes commands and reports unknown, unavailable, or thrown handlers', async () => {
    const registry = new CommandRegistry();
    const run = command();
    const guiOnly = command({ id: 'gui', surfaces: ['gui'], aliases: [] });
    const failing = command({
      id: 'fail',
      aliases: [],
      handler: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    registry.register(run);
    registry.register(guiOnly);
    registry.register(failing);

    await expect(registry.execute('r', ctx, ['one'])).resolves.toEqual({
      success: true,
      data: { args: ['one'] },
    });
    await expect(registry.execute('missing', ctx, [])).resolves.toEqual({
      success: false,
      message: 'Unknown command: /missing',
    });
    await expect(registry.execute('gui', ctx, [])).resolves.toEqual({
      success: false,
      message: 'Command /gui is not available on cli',
    });
    await expect(registry.execute('fail', ctx, [])).resolves.toEqual({
      success: false,
      message: 'boom',
    });
  });
});
