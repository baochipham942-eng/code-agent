import { describe, expect, it, vi } from 'vitest';
import { killPortHolder } from '../../../src/web/portCleanup';

describe('killPortHolder', () => {
  it('kills only other holders and logs each target command before killing', async () => {
    const events: string[] = [];
    const exec = vi.fn((file: string, args: string[]) => {
      events.push(`exec:${file}:${args.join(' ')}`);
      if (file === 'lsof') return '101\n202\n';
      if (file === 'ps' && args[1] === '101') return 'node dist/web/webServer.cjs';
      if (file === 'ps' && args[1] === '202') throw new Error('process exited');
      return '';
    });
    const log = vi.fn((message: string) => events.push(`log:${message}`));

    await killPortHolder(28_080, {
      currentPid: '999',
      exec,
      log,
      wait: async () => {},
    });

    expect(log).toHaveBeenCalledWith(
      '  Killing zombie process on port 28080: PID 101, command: node dist/web/webServer.cjs',
    );
    expect(log).toHaveBeenCalledWith(
      '  Killing zombie process on port 28080: PID 202, command: <command unavailable>',
    );
    expect(exec).toHaveBeenLastCalledWith('kill', ['-9', '101', '202']);
    expect(events).toEqual([
      'exec:lsof:-ti :28080',
      'exec:ps:-p 101 -o command=',
      'log:  Killing zombie process on port 28080: PID 101, command: node dist/web/webServer.cjs',
      'exec:ps:-p 202 -o command=',
      'log:  Killing zombie process on port 28080: PID 202, command: <command unavailable>',
      'exec:kill:-9 101 202',
    ]);
  });
});
