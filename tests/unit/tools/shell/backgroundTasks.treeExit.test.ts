// 走产品真路径（startBackgroundTask / killBackgroundTask）验收尸：
// 只测 killProcessTree 证明不了后台任务这一支——它还取决于 spawn 时有没有 detached 成组、
// 收树时有没有传 posixGroupKill。2026-07-30 孤儿 Chrome 事故坏的正是这两项。
// 证据档位：real-runtime。
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getAllBackgroundTasks,
  killBackgroundTask,
  startBackgroundTask,
} from '../../../../src/host/tools/shell/backgroundTasks';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

posixOnly('后台任务停机收尸', () => {
  const startedTaskIds: string[] = [];

  afterEach(async () => {
    for (const taskId of startedTaskIds.splice(0)) {
      await killBackgroundTask(taskId).catch(() => undefined);
    }
  });

  it('kill 后台任务时，它 spawn 出来的孙进程一起死干净', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    // 孙进程把自己的 pid 写到文件里——这就是「跑 e2e 脚本的后台任务拉起 Playwright worker」
    // 的最小形状。旧实现只杀 bash，这个 sleep 会被 init 收养继续活着。
    const pidFile = `${cwd}/grandchild.pid`;
    const started = startBackgroundTask(`sleep 120 & echo $! > ${pidFile}; wait`, cwd);
    expect(started.success).toBe(true);
    startedTaskIds.push(started.taskId!);

    const { readFileSync, existsSync } = await import('fs');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim().length > 0);
    const grandchildPid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    const result = await killBackgroundTask(started.taskId!);

    expect(result.success).toBe(true);
    // 承重断言：killBackgroundTask 返回时孙进程必须已经死了，不能是「信号发出去了」
    expect(pidAlive(grandchildPid)).toBe(false);
    expect(getAllBackgroundTasks().find((t) => t.taskId === started.taskId)?.status).not.toBe('running');
  }, 30000);

  it('reapChildProcesses 收掉全部在跑的后台任务（停机属主调的就是它）', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const started = startBackgroundTask('sleep 120', cwd);
    expect(started.success).toBe(true);
    startedTaskIds.push(started.taskId!);
    await waitFor(() => getAllBackgroundTasks().some(
      (t) => t.taskId === started.taskId && t.status === 'running',
    ));

    const { reapChildProcesses } = await import('../../../../src/host/tools/shell/shutdownReaper');
    const { killedTasks } = await reapChildProcesses('test_shutdown');

    expect(killedTasks).toBeGreaterThanOrEqual(1);
    expect(getAllBackgroundTasks().some((t) => t.status === 'running')).toBe(false);
  }, 30000);
});
