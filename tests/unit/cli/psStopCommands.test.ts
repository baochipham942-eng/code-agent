// ============================================================================
// /ps /stop 后台任务命令（newCommands.ts）单测：只读呈现 + 前缀匹配终止。
// 任务表走注入端口，不加载 host 模块、不起真进程。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newCommands } from '../../../src/shared/commands/definitions/newCommands';
import type { CommandContext, CommandDefinition, CommandOutput } from '../../../src/shared/commands/types';

const bgState = {
  tasks: [] as Array<Record<string, unknown>>,
  kill: vi.fn(),
};

function cliCtx(output: CommandOutput): CommandContext {
  return {
    surface: 'cli',
    output,
    loadBackgroundTasks: async () => ({
      getAllBackgroundTasks: () => bgState.tasks,
      killBackgroundTask: bgState.kill,
    }),
  };
}

function mustGetCommand(id: string): CommandDefinition {
  const command = newCommands.find((c) => c.id === id);
  if (!command) throw new Error(`command ${id} not registered`);
  return command;
}
const psCommand = mustGetCommand('ps');
const stopCommand = mustGetCommand('stop');

function makeOutput(): CommandOutput & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => { lines.push(m); },
    success: (m: string) => { lines.push(m); },
    error: (m: string) => { lines.push(m); },
    warn: (m: string) => { lines.push(m); },
  };
}

function task(id: string, status: string, command = 'npm run dev'): Record<string, unknown> {
  return {
    taskId: id,
    status,
    command,
    cwd: '/tmp',
    startTime: Date.now() - 5000,
    duration: 5000,
    outputFile: `/tmp/${id}.log`,
  };
}

describe('/ps', () => {
  beforeEach(() => {
    bgState.tasks = [];
    bgState.kill.mockReset();
  });

  it('无任务时空提示', async () => {
    const output = makeOutput();
    const result = await psCommand.handler(cliCtx(output), []);
    expect(result.success).toBe(true);
    expect(output.lines[0]).toContain('没有后台任务');
  });

  it('列出任务状态/耗时/命令（新的在前）', async () => {
    bgState.tasks = [
      task('aaaaaaaa-1111', 'running'),
      { ...task('bbbbbbbb-2222', 'failed', 'sleep 999'), exitCode: 1 },
    ];
    const output = makeOutput();
    await psCommand.handler(cliCtx(output), []);
    const text = output.lines.join('\n');
    expect(text).toContain('aaaaaaaa');
    expect(text).toContain('running');
    expect(text).toContain('bbbbbbbb');
    expect(text).toContain('exit=1');
    expect(text).toContain('/stop');
  });
});

describe('/stop', () => {
  beforeEach(() => {
    bgState.tasks = [task('aaaaaaaa-1111', 'running')];
    bgState.kill.mockReset();
    bgState.kill.mockResolvedValue({ success: true, message: 'killed' });
  });

  it('空参数报用法', async () => {
    const result = await stopCommand.handler(cliCtx(makeOutput()), []);
    expect(result.success).toBe(false);
    expect(result.message).toContain('/stop');
  });

  it('前缀匹配终止运行中任务', async () => {
    const output = makeOutput();
    const result = await stopCommand.handler(cliCtx(output), ['aaaa']);
    expect(bgState.kill).toHaveBeenCalledWith('aaaaaaaa-1111');
    expect(result.success).toBe(true);
    expect(output.lines.join('\n')).toContain('aaaaaaaa');
  });

  it('无匹配 / 多前缀歧义 / 已结束任务', async () => {
    expect((await stopCommand.handler(cliCtx(makeOutput()), ['zz'])).success).toBe(false);
    bgState.tasks.push(task('aaaabbbb-3333', 'running'));
    const ambiguous = await stopCommand.handler(cliCtx(makeOutput()), ['aaaa']);
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.message).toContain('2 个任务');
    bgState.tasks = [task('cccccccc-4444', 'completed')];
    const done = await stopCommand.handler(cliCtx(makeOutput()), ['cccc']);
    expect(done.success).toBe(true);
    expect(bgState.kill).not.toHaveBeenCalledWith('cccccccc-4444');
  });

  it('kill 失败透传错误', async () => {
    bgState.kill.mockResolvedValue({ success: false, error: 'boom' });
    const result = await stopCommand.handler(cliCtx(makeOutput()), ['aaaa']);
    expect(result).toMatchObject({ success: false, message: 'boom' });
  });
});
