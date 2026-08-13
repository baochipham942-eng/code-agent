// 整树退出证明（T-018）：这些判据 mock 造不出来——「树死没死」只有真进程能回答。
// 证据档位：fault-injection / real-runtime。
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { killProcessTree } from '../../../../src/host/tools/shell/platformShell';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

/** 与 backgroundTasks / bash 工具同构：detached 让子进程自成进程组，才能整组收树。 */
function spawnGroup(script: string): ChildProcess {
  return spawn('bash', ['-c', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function groupAlive(pid: number): boolean {
  return pidAlive(-pid);
}

/** 等子进程真的跑起来（拿到它 stdout 的第一行）。 */
function firstLine(child: ChildProcess, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('子进程未在预期时间内输出')), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(buffered.slice(0, newline).trim());
      }
    });
  });
}

posixOnly('killProcessTree 整树退出证明', () => {
  it('负例：进程忽略 SIGTERM 时，等到宽限期届满升级 SIGKILL，并确认树已死才返回', async () => {
    // trap '' TERM = 彻底忽略 SIGTERM。改动前 killProcessTree 发完信号就 return，
    // 调用方拿到「已终止」而进程还活着。
    const child = spawnGroup("trap '' TERM; echo up; while true; do sleep 0.2; done");
    expect(await firstLine(child)).toBe('up');

    const startedAt = Date.now();
    await killProcessTree(child, { posixGroupKill: true, graceMs: 400, pollIntervalMs: 25 });
    const elapsed = Date.now() - startedAt;

    // 真的等满了宽限期才升级（没有立刻返回）
    expect(elapsed).toBeGreaterThanOrEqual(400);
    // 真的确认树死了（不是「发过信号就算」）
    expect(groupAlive(child.pid!)).toBe(false);
    expect(child.signalCode).toBe('SIGKILL');
  }, 15000);

  it('正例：正常进程被 SIGTERM 收掉后快速返回，不升级 SIGKILL、不空等满宽限期', async () => {
    // `exec` 让 bash 就地换成 sleep：组里自始至终只有一个进程，没有 fork/exec 竞态。
    // （不加 exec 时实测有真实竞态：SIGTERM 落在 bash 已 fork、sleep 还没 exec 的窗口里，
    //  bash 死了而 sleep 活下来被 init 收养——正是这单要治的「发完信号 ≠ 树死了」。
    //  那条路径由下面的「孙进程一起收」用例覆盖。）
    const child = spawnGroup('echo up; exec sleep 30');
    expect(await firstLine(child)).toBe('up');

    const startedAt = Date.now();
    await killProcessTree(child, { posixGroupKill: true, graceMs: 3000, pollIntervalMs: 25 });
    const elapsed = Date.now() - startedAt;

    // 判据不只看时间：signalCode 是 SIGTERM 就证明压根没走到升级那一步
    expect(child.signalCode).toBe('SIGTERM');
    expect(elapsed).toBeLessThan(1500);
    expect(groupAlive(child.pid!)).toBe(false);
  }, 15000);

  it('孙进程一起收：这才是孤儿 Playwright/Chrome 事故的形状', async () => {
    // bash 自己退出后，被 `&` 后台化的孙进程会被 init 收养继续活着——
    // 只杀直接子进程的话它们全留下来。
    const child = spawnGroup('sleep 30 & echo $!; sleep 30 & echo $!; wait');
    const grandchildPid = Number(await firstLine(child));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    await killProcessTree(child, { posixGroupKill: true, graceMs: 400, pollIntervalMs: 25 });

    expect(groupAlive(child.pid!)).toBe(false);
    expect(pidAlive(grandchildPid)).toBe(false);
  }, 15000);

  it('宿主不在被杀的进程组里（对照 claude-code #45717：Bash 工具超时把宿主自己杀了）', async () => {
    const child = spawnGroup('echo up; sleep 30');
    expect(await firstLine(child)).toBe('up');

    // detached 让 child 另开一组；我们只对 -child.pid 发信号，宿主的组不在其中。
    const pgid = (pid: number) => execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim();
    expect(pgid(child.pid!)).not.toBe(pgid(process.pid));

    await killProcessTree(child, { posixGroupKill: true, graceMs: 400, pollIntervalMs: 25 });

    // 断言宿主自己还在（这一行能跑到就已经是证据，但显式写出判据）
    expect(pidAlive(process.pid)).toBe(true);
    expect(groupAlive(child.pid!)).toBe(false);
  }, 15000);

  it('永久退出边界：树已确认退出后再调一次立刻返回，不会对复用的 pid 再发信号', async () => {
    const child = spawnGroup('echo up; sleep 30');
    expect(await firstLine(child)).toBe('up');
    await killProcessTree(child, { posixGroupKill: true, graceMs: 400, pollIntervalMs: 25 });

    const startedAt = Date.now();
    await killProcessTree(child, { posixGroupKill: true, graceMs: 400, pollIntervalMs: 25 });

    // 一轮轮询都不该跑（记住了退出边界就直接返回）
    expect(Date.now() - startedAt).toBeLessThan(25);
  }, 15000);
});

// 反例守护：不夺取进程终止权。新增 SIGTERM/SIGINT 处理器会抢在停机属主之前
// exit(0)，让干净关库一步都跑不到（2026-08-08 真机事故）。
describe('信号处理器注册点白名单', () => {
  const ALLOWED = new Set([
    'src/host/mcp/mcp-server-entry.ts',
    'src/host/services/infra/gracefulShutdown.ts',
    'src/web/webServer.ts',
    'src/web/routes/devCancellableToolSmoke.ts',
    'src/cli/tui/tuiChat.ts',
    'src/cli/commands/chat.ts',
    'src/cli/commands/serve.ts',
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('src/ 下注册 SIGTERM/SIGINT 的文件没有新增', () => {
    const root = join(__dirname, '../../../../src');
    const pattern = /process\.on\(\s*['"]SIG(?:TERM|INT)['"]/;
    // 跳过注释行：backgroundTasks.ts 的教训注释里原样引用了这段代码
    const registersSignal = (source: string): boolean => source
      .split('\n')
      .some((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
        return pattern.test(line);
      });
    const found = walk(root)
      .filter((file) => registersSignal(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(file.indexOf('/src/') + 1))
      .sort();

    // 扫到 0 个 = 扫描本身坏了，不能算通过
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  // 收尸逻辑本身有真进程用例（backgroundTasks.treeExit.test.ts）；这里守的是**接线**：
  // 两个停机属主真的调了它。产品代码里零调用方的收尸函数 = 白写（cancelAll 就是前车之鉴）。
  it('两个停机属主都接了 reapChildProcesses', () => {
    const root = join(__dirname, '../../../../src');
    const owners = ['web/webServer.ts', 'cli/bootstrap.ts'];
    for (const owner of owners) {
      const source = readFileSync(join(root, owner), 'utf-8');
      expect(source, `${owner} 没接收尸`).toContain('reapChildProcesses');
    }
  });
});
