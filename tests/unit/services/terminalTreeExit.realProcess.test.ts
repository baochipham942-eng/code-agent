// Terminal 会话整树退出证明（N-DSH-STOP4）：走产品真路径
// openTerminalSession / disposeTerminalSession / reapChildProcesses。
//
// 为什么必须用真 PTY：mock 句柄的 pid 是编出来的，「组死没死」它回答不了；
// 而 node-pty 的终止语义（setsid 自成组、kill() 默认 SIGHUP 且吞异常）也是 mock 造不出来的。
// 证据档位：real-runtime / fault-injection。
//
// 🔴 两道运行前提（与 tests/unit/tools/shell/ptyTreeExit.realProcess.test.ts 同）：
//   1. tests/setup.ts 把 node-pty 全局 mock 成 `{ pid: 0, kill(){} }`——这里用
//      vi.doUnmock + 动态 import 拿真模块。
//   2. **CI 上起不来真 PTY，两个 runner 各坏各的**：linux-x64 缺原生产物，模块加载阶段就炸；
//      macOS 加载得了但 `pty.spawn` 抛 `posix_spawnp failed.`。所以能力探测**必须真 spawn 一次**。
//      CI 上真进程用例整组 skip——skip 不是假绿：下面「接线守护」那组**不跳过**。
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SHELL_KILL } from '../../../src/shared/constants/tools';

/** 这台机器真的能起 PTY 吗：判据锚能力本身（真 spawn 一次 + pid > 0），不锚「import 得了」。 */
async function probeRealPty(): Promise<boolean> {
  try {
    const realPty = await vi.importActual<typeof import('node-pty')>('node-pty');
    const probe = realPty.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: process.env as Record<string, string>,
    });
    const spawned = probe.pid > 0;
    try { probe.kill(); } catch { /* 已退出 */ }
    return spawned;
  } catch {
    return false;
  }
}

const realPtyAvailable = await probeRealPty();

// doUnmock 不被 hoist，只对之后的动态 import 生效——正好用来按能力分流
vi.doUnmock('node-pty');

type TerminalManager = typeof import('../../../src/host/services/terminal/terminalSessionManager');
const terminal: TerminalManager | null = realPtyAvailable
  ? await import('../../../src/host/services/terminal/terminalSessionManager')
  : null;

const canRunRealPty = realPtyAvailable && process.platform !== 'win32';

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

function commOf(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function pgidOf(pid: number): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

let sessionSeq = 0;
const offOutput: Array<() => void> = [];

/**
 * 取会话的真 pid。
 *
 * 产品没有把 pid 暴露在 TerminalSnapshot 里（渲染端不需要），也不该为测试新开一个导出——
 * 但它**本来就把活着的 pid 记在账本上**（persistLivePids，孤儿收割要用），
 * 直接读那份真产物即可，顺带还验了账本确实在记。
 */
function ledgerPids(): number[] {
  const file = join(process.env.CODE_AGENT_DATA_DIR!, 'terminal-pids.json');
  try {
    return (JSON.parse(readFileSync(file, 'utf-8')) as Array<{ pid: number }>).map((entry) => entry.pid);
  } catch {
    return [];
  }
}

/**
 * 开一个真终端会话并等交互 shell 出第一口气；返回 sessionId、shell pid 和输出缓冲。
 *
 * 这个子系统起的是**交互登录 shell**（`-i -l`，用户要在里面 `ssh` / `grok login`），
 * 不像 ptyExecutor 那样能把命令直接塞进 spawn 参数——要跑什么只能往 stdin 里写。
 */
async function startSession(): Promise<{
  sessionId: string;
  pid: number;
  read: () => string;
}> {
  const mod = terminal!;
  const sessionId = `real-term-${(sessionSeq += 1)}`;
  const cwd = mkdtempSync(`${tmpdir()}/neo-term-`);
  let buffered = '';
  const off = mod.onTerminalOutput((id, data) => { if (id === sessionId) buffered += data; });
  const before = new Set(ledgerPids());
  const snapshot = mod.openTerminalSession({ sessionId, cwd });
  expect(snapshot.alive).toBe(true);
  const added = ledgerPids().filter((pid) => !before.has(pid));
  expect(added, 'pid 账本没记下新开的终端').toHaveLength(1);
  const livePid = added[0];
  // fail-loud：mock 句柄的 pid 恒为 0。真 pid 才有「组」可言，
  // 万一 mock 漏回来，这里立刻报红，而不是在假句柄上跑出一片假绿。
  expect(livePid, 'node-pty 是 mock 句柄（pid=0），这组用例失去意义').toBeGreaterThan(0);
  // 等交互 shell 把 rc 跑完、提示符吐出来，再往里写命令
  await waitFor(() => buffered.length > 0);
  offOutput.push(off);
  return { sessionId, pid: livePid, read: () => buffered };
}

/** 往会话里写一行命令；判据锚可观测的副作用，不锚时间。 */
function run(sessionId: string, line: string): void {
  terminal!.writeToTerminalSession(sessionId, `${line}\n`);
}

/**
 * 在会话里起一个**顽固后台进程**并拿到它的 pid。
 *
 * 🔴 顽固进程只能是 shell 的**子进程**，不能靠 `trap "" TERM; exec sleep` 把交互 shell 自己换掉：
 * 实测（本机 zsh 5.9 / darwin）交互 shell 走 exec 时**不保留 `trap ""` 的 SIG_IGN**——
 * 它 exec 出来的 sleep 挨 SIGHUP 不死、挨 SIGTERM 就死；
 * 而非交互的 `bash -c 'trap "" HUP TERM INT; exec sleep 300'`（和 zsh -c 一样）两个信号都能扛住。
 *
 * 🔴 顺带钉死本单的真根因：交互 shell 开着 job control，`&` 起的后台任务会被放进
 * **独立进程组**（下面 pgid 断言就是守这条），只按 leader 的组收根本收不到它。
 */
async function startStubbornChild(sessionId: string, read: () => string): Promise<number> {
  run(sessionId, 'bash -c \'trap "" HUP TERM INT; exec sleep 300\' & echo GC=$!');
  await waitFor(() => /GC=(\d+)/.test(read()));
  const pid = Number(/GC=(\d+)/.exec(read())![1]);
  await waitFor(() => commOf(pid) === 'sleep');
  return pid;
}

describe.skipIf(!canRunRealPty)('Terminal 会话整树退出证明（真 node-pty）', () => {
  const openedPids: number[] = [];
  const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

  // pid 账本落 getUserConfigDir()，不隔离的话测试会往用户真数据目录里写
  beforeAll(() => { process.env.CODE_AGENT_DATA_DIR = mkdtempSync(`${tmpdir()}/neo-term-datadir-`); });
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  });

  afterEach(() => {
    for (const off of offOutput.splice(0)) off();
    for (const pid of openedPids.splice(0)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* 已死 */ }
    }
  });

  it('负例：会话里有忽略终止信号的进程时，等到宽限期届满升级 SIGKILL，确认死了才返回', async () => {
    // 改动前：disposeTerminalSession 发完 pty.kill() 立刻 return true，顽固进程原地不动。
    const { sessionId, pid, read } = await startSession();
    openedPids.push(pid);
    const stubborn = await startStubbornChild(sessionId, read);
    expect(pidAlive(stubborn)).toBe(true);

    const startedAt = Date.now();
    const closed = await terminal!.disposeTerminalSession(sessionId);
    const elapsed = Date.now() - startedAt;

    expect(closed).toBe(true);
    // 真的等满宽限期才升级，而不是发完信号就宣布「已关闭」
    expect(elapsed).toBeGreaterThanOrEqual(SHELL_KILL.GRACE_MS);
    // 承重断言：返回那一刻它必须已经消失
    expect(pidAlive(stubborn)).toBe(false);
    expect(groupAlive(pid)).toBe(false);
  }, 60000);

  it('正例：正常会话快速返回，且压根没走到升级那一步', async () => {
    const { sessionId, pid } = await startSession();
    openedPids.push(pid);

    // 判据不只看时间：盯住真正发到这个会话上的信号，SIGKILL 一次都不该出现
    const originalKill = process.kill.bind(process);
    const sentSignals: Array<string | number | undefined> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      target: number,
      signal?: NodeJS.Signals | number,
    ): true => {
      if (target === -pid || target === pid) sentSignals.push(signal);
      return originalKill(target, signal);
    }) as typeof process.kill);

    const startedAt = Date.now();
    const closed = await terminal!.disposeTerminalSession(sessionId);
    const elapsed = Date.now() - startedAt;
    killSpy.mockRestore();

    expect(closed).toBe(true);
    expect(sentSignals).not.toContain('SIGKILL');
    expect(elapsed).toBeLessThan(SHELL_KILL.GRACE_MS);
    expect(groupAlive(pid)).toBe(false);
  }, 60000);

  it('负例：后台任务在独立进程组里，按组收收不到——它也必须被收干净（无残留）', async () => {
    const { sessionId, pid, read } = await startSession();
    openedPids.push(pid);
    const grandchildPid = await startStubbornChild(sessionId, read);

    // 🔴 本单的真根因钉在这里：交互 shell 的 job control 把 `&` 起的任务放进**自己的**进程组，
    // 所以 ptyExecutor 那套「按 leader 进程组收」在这个子系统里是够不着的。
    expect(pgidOf(grandchildPid)).not.toBe(pgidOf(pid));
    expect(pidAlive(grandchildPid)).toBe(true);

    await terminal!.disposeTerminalSession(sessionId);

    expect(pidAlive(grandchildPid)).toBe(false);
    expect(groupAlive(pid)).toBe(false);
  }, 60000);

  it('宿主不在被杀的进程组里（对照 claude-code #45717）', async () => {
    const { sessionId, pid } = await startSession();
    openedPids.push(pid);

    // node-pty 用 POSIX_SPAWN_SETSID/forkpty 建新会话：终端自成一组，宿主的组不在其中
    expect(pgidOf(pid)).not.toBe(pgidOf(process.pid));

    await terminal!.disposeTerminalSession(sessionId);

    expect(pidAlive(process.pid)).toBe(true);
    expect(groupAlive(pid)).toBe(false);
  }, 60000);

  it('reapChildProcesses 收掉在跑的终端会话（停机属主调的就是它）', async () => {
    const { pid } = await startSession();
    openedPids.push(pid);

    const { reapChildProcesses } = await import('../../../src/host/tools/shell/shutdownReaper');
    const { killedTerminalSessions } = await reapChildProcesses('test_shutdown');

    expect(killedTerminalSessions).toBeGreaterThanOrEqual(1);
    expect(groupAlive(pid)).toBe(false);
  }, 60000);

  it('收干净之后 pid 账本里不再留这个会话（下次启动的孤儿收割无事可做）', async () => {
    const { sessionId, pid } = await startSession();
    openedPids.push(pid);
    await terminal!.disposeTerminalSession(sessionId);

    expect(terminal!.reapOrphanTerminals()).toBe(0);
  }, 60000);
});

// **这一组永不跳过**：上面的真进程用例在 CI（无 node-pty 原生产物）上整组 skip，
// 收尸接线不能因此失守。守的是「终端真的在收尸清单里」——产品代码里零调用方的
// 收尸函数 = 白写（STOP1 的 cancelAll、STOP2 的 lifecycle.ts 都是前车之鉴）。
describe('Terminal 收尸接线守护（不依赖原生模块）', () => {
  const root = join(__dirname, '../../../src');

  it('reapChildProcesses 收终端会话，且停机属主把计数打进日志', () => {
    const reaper = readFileSync(join(root, 'host/tools/shell/shutdownReaper.ts'), 'utf-8');
    expect(reaper, '收尸入口没收终端会话').toContain('reapTerminalSessions');
    expect(reaper, '收尸返回值没带终端计数').toContain('killedTerminalSessions');

    // 不留痕的步骤事后无法判断跑没跑过（本仓吃过 exitReason 看着完美、日志一行没打的亏）
    const webServer = readFileSync(join(root, 'web/webServer.ts'), 'utf-8');
    expect(webServer, '停机日志没带终端计数').toContain('terminal session(s)');
  });

  it('disposeTerminalSession 是 async 且走整树退出证明', () => {
    const source = readFileSync(join(root, 'host/services/terminal/terminalSessionManager.ts'), 'utf-8');
    expect(source).toMatch(/export async function disposeTerminalSession/);
    expect(source, '终端终止没走整树退出证明').toContain('killProcessTree');
    // 那张 onShutdown 注册表从没跑过（setupDefaultSignalHandlers 零调用方），
    // 挂在上面等于让人以为收了、其实没收——STOP4 已经把它换成 reapTerminalSessions。
    expect(source, '别再把终端收尾挂回从没跑过的 onShutdown 注册表').not.toContain('onShutdown(');
  });

  it('两个外部调用方都 await 了 dispose（不 await 等于退回发完信号就走）', () => {
    for (const file of ['host/ipc/terminal.ipc.ts', 'host/ipc/session.ipc.ts']) {
      const source = readFileSync(join(root, file), 'utf-8');
      expect(source, `${file} 没 await disposeTerminalSession`).toContain('await disposeTerminalSession');
    }
  });

  it('孤儿收割的两道核对还在（防误杀复用 pid）', () => {
    const source = readFileSync(join(root, 'host/services/terminal/terminalSessionManager.ts'), 'utf-8');
    expect(source, 'owner host 存活核对没了').toContain('isProcessAlive(entry.ownerPid)');
    expect(source, 'pid 是否还是同一个 shell 的核对没了').toContain('pidStillMatchesShell');
  });
});
