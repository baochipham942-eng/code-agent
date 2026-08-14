// PTY 会话整树退出证明（T-028）：走产品真路径 createPtySession / killPtySession。
// node-pty 不是 child_process，它的终止语义（setsid 自成组、kill() 默认 SIGHUP 且吞异常）
// mock 造不出来——「组死没死」只有真进程能回答。
// 证据档位：real-runtime / fault-injection。
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// tests/setup.ts 把 node-pty 全局 mock 成 `{ pid: 0, kill(){} }`——那个假句柄回答不了
// 「组死没死」这个本单唯一重要的问题。这里显式撤销，用真 node-pty 跑真 PTY。
vi.unmock('node-pty');

import {
  createPtySession,
  getPtySession,
  killPtySession,
} from '../../../../src/host/tools/shell/ptyExecutor';
import { SHELL_KILL } from '../../../../src/shared/constants/tools';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

/** 起一个 PTY 会话并等它把第一行吐出来；返回 sessionId、shell pid 和输出缓冲。 */
async function startSession(command: string): Promise<{
  sessionId: string;
  pid: number;
  read: () => string;
}> {
  const cwd = mkdtempSync(`${tmpdir()}/neo-pty-`);
  const created = await createPtySession({ command, args: [], cwd });
  expect(created.success, created.error).toBe(true);
  const session = getPtySession(created.sessionId!);
  expect(session).toBeDefined();
  let buffered = '';
  session!.pty.onData((chunk) => { buffered += chunk; });
  await waitFor(() => buffered.includes('READY'));
  return { sessionId: created.sessionId!, pid: session!.pty.pid, read: () => buffered };
}

posixOnly('PTY 会话整树退出证明', () => {
  const openedPids: number[] = [];
  const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

  // PTY 输出日志落 getUserConfigDir()，不隔离的话测试会往用户真数据目录里写
  beforeAll(() => { process.env.CODE_AGENT_DATA_DIR = mkdtempSync(`${tmpdir()}/neo-pty-datadir-`); });
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  });

  afterEach(() => {
    // 用例自己失败时别把残留留给下一个用例（也别留给这台机器）
    for (const pid of openedPids.splice(0)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* 已死 */ }
    }
  });

  it('负例：会话忽略终止信号时，等到宽限期届满升级 SIGKILL，确认整组死了才返回', async () => {
    // trap "" HUP TERM INT = 彻底忽略；exec 让 bash 就地换成 sleep，忽略态随 exec 继承。
    // 改动前：killPtySession 1ms 返回 success=true，而 shell 和整组都还活着。
    const { sessionId, pid } = await startSession('trap "" HUP TERM INT; echo READY; exec sleep 300');
    openedPids.push(pid);
    expect(groupAlive(pid)).toBe(true);

    const startedAt = Date.now();
    const result = await killPtySession(sessionId);
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(true);
    // 真的等满宽限期才升级，而不是发完 SIGHUP 就宣布「已终止」
    expect(elapsed).toBeGreaterThanOrEqual(SHELL_KILL.GRACE_MS);
    // 承重断言：返回那一刻整组必须已经消失
    expect(groupAlive(pid)).toBe(false);
    expect(pidAlive(pid)).toBe(false);
  }, 30000);

  it('正例：正常会话快速返回，且压根没走到升级那一步', async () => {
    const { sessionId, pid } = await startSession('echo READY; exec sleep 300');
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
    const result = await killPtySession(sessionId);
    const elapsed = Date.now() - startedAt;
    killSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(sentSignals).not.toContain('SIGKILL');
    expect(elapsed).toBeLessThan(SHELL_KILL.GRACE_MS);
    expect(groupAlive(pid)).toBe(false);
  }, 30000);

  it('负例：PTY 里 spawn 出的孙进程忽略信号时，也被一起收干净（无残留）', async () => {
    // 改动前实测：killPtySession 0ms 返回 success=true，孙进程还活着 → 孤儿。
    const { sessionId, pid, read } = await startSession(
      'bash -c \'trap "" HUP TERM INT; exec sleep 300\' & echo GC=$!; echo READY; exec sleep 300',
    );
    openedPids.push(pid);
    const grandchildPid = Number(/GC=(\d+)/.exec(read())?.[1]);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);
    // 孙进程与 shell 同组，才谈得上按组收（node-pty 的 setsid 语义）
    const pgid = (target: number) => execFileSync('ps', ['-o', 'pgid=', '-p', String(target)]).toString().trim();
    expect(pgid(grandchildPid)).toBe(String(pid));

    await killPtySession(sessionId);

    expect(pidAlive(grandchildPid)).toBe(false);
    expect(groupAlive(pid)).toBe(false);
  }, 30000);

  it('宿主不在被杀的进程组里（对照 claude-code #45717）', async () => {
    const { sessionId, pid } = await startSession('echo READY; exec sleep 300');
    openedPids.push(pid);

    // node-pty 用 POSIX_SPAWN_SETSID/forkpty 建新会话：PTY 自成一组，宿主的组不在其中
    const pgid = (target: number) => execFileSync('ps', ['-o', 'pgid=', '-p', String(target)]).toString().trim();
    expect(pgid(pid)).not.toBe(pgid(process.pid));

    await killPtySession(sessionId);

    expect(pidAlive(process.pid)).toBe(true);
    expect(groupAlive(pid)).toBe(false);
  }, 30000);

  it('reapChildProcesses 收掉在跑的 PTY 会话（停机属主调的就是它）', async () => {
    const { pid } = await startSession('echo READY; exec sleep 300');
    openedPids.push(pid);

    const { reapChildProcesses } = await import('../../../../src/host/tools/shell/shutdownReaper');
    const { killedPtySessions } = await reapChildProcesses('test_shutdown');

    expect(killedPtySessions).toBeGreaterThanOrEqual(1);
    expect(groupAlive(pid)).toBe(false);
  }, 30000);

  it('永久退出边界：已确认退出的会话再收一次立刻返回，不对复用的 pid 发信号', async () => {
    const { sessionId, pid } = await startSession('echo READY; exec sleep 300');
    openedPids.push(pid);
    await killPtySession(sessionId);

    const startedAt = Date.now();
    await killPtySession(sessionId);

    expect(Date.now() - startedAt).toBeLessThan(SHELL_KILL.POLL_INTERVAL_MS);
  }, 30000);
});
