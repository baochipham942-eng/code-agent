// PTY 会话整树退出证明（T-028）：走产品真路径 createPtySession / killPtySession。
// node-pty 不是 child_process，它的终止语义（setsid 自成组、kill() 默认 SIGHUP 且吞异常）
// mock 造不出来——「组死没死」只有真进程能回答。
// 证据档位：real-runtime / fault-injection。
//
// 🔴 两道运行前提，缺一这些用例就跑不了真 PTY：
//   1. tests/setup.ts 把 node-pty 全局 mock 成 `{ pid: 0, kill(){} }`——那个假句柄回答不了
//      「组死没死」。这里用 vi.doUnmock + 动态 import 拿真模块。
//   2. **CI 上起不来真 PTY，而且两个 runner 各坏各的**：
//      - linux-x64：原生产物压根不存在（`Cannot find module './prebuilds/linux-x64//pty.node'`），
//        **模块加载阶段**就炸；
//      - macOS（Main Full Gate 那台）：模块加载得了，但 `pty.spawn` 运行时抛
//        `posix_spawnp failed.`（起不了 node-pty 的 spawn-helper）。
//      所以能力探测**必须真 spawn 一次**——「模块 import 得了」是代理信号，不是能力本身。
//      真 PTY 用例只能在本机跑，CI 上整组 skip——skip 不是假绿：下面「接线守护」那组**不跳过**，
//      CI 照样守着收尸接线，本机再补真进程证明。
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SHELL_KILL } from '../../../../src/shared/constants/tools';

// 这台机器**真的能起 PTY 吗**：判据锚能力本身（真 spawn 一次 + pid > 0），
// 不锚「模块 import 得了」这种代理信号——macOS CI 上正是 import 得了但 spawn 失败。
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
    // linux CI：原生产物不存在，import 就炸；macOS CI：import 得了但 spawn 抛 posix_spawnp failed
    return false;
  }
}

const realPtyAvailable = await probeRealPty();

// doUnmock 不被 hoist，只对之后的动态 import 生效——正好用来按能力分流
vi.doUnmock('node-pty');

// ⚠️ 已知副作用（实测）：这个 conditional dynamic import 会让 knip 的 **default 档**
// 把 ptyExecutor 的**每一个**导出都算作「已使用」。改成命名解构**没用**
// （knip 分析的是 `import()` 表达式本身，不是解构模式），而条件动态 import 是 CI 分流必需的，
// 退不回静态 import。N-DSH-STOP6 已把那批被它遮住的零 importer 死导出删干净并同步了基线，
// 但**盲区本身仍在**：往这个文件新加一个零调用方的导出，default 档照样绿（变异实测过）。
// 守着它的是 `knip-ratchet --profile production`（只认生产入口，测试引用不算消费方），
// 那一档能红。所以别指望 default 档给这个文件把关。
// 详见 docs/design/2026-08-14-pty-executor-dead-export-map.md §6。
type PtyExecutor = typeof import('../../../../src/host/tools/shell/ptyExecutor');
const ptyExecutor: PtyExecutor | null = realPtyAvailable
  ? await import('../../../../src/host/tools/shell/ptyExecutor')
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
  const mod = ptyExecutor!;
  const cwd = mkdtempSync(`${tmpdir()}/neo-pty-`);
  const created = mod.createPtySession({ command, args: [], cwd });
  expect(created.success, created.error).toBe(true);
  const session = mod.getPtySession(created.sessionId!);
  expect(session).toBeDefined();
  // fail-loud：mock 句柄的 pid 恒为 0。真 pid 才有「组」可言，
  // 万一 mock 漏回来，这里立刻报红，而不是在假句柄上跑出一片假绿。
  expect(session!.pty.pid, 'node-pty 是 mock 句柄（pid=0），这组用例失去意义').toBeGreaterThan(0);
  let buffered = '';
  session!.pty.onData((chunk) => { buffered += chunk; });
  await waitFor(() => buffered.includes('READY'));
  return { sessionId: created.sessionId!, pid: session!.pty.pid, read: () => buffered };
}

describe.skipIf(!canRunRealPty)('PTY 会话整树退出证明（真 node-pty）', () => {
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
    const result = await ptyExecutor!.killPtySession(sessionId);
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
    const result = await ptyExecutor!.killPtySession(sessionId);
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

    await ptyExecutor!.killPtySession(sessionId);

    expect(pidAlive(grandchildPid)).toBe(false);
    expect(groupAlive(pid)).toBe(false);
  }, 30000);

  it('宿主不在被杀的进程组里（对照 claude-code #45717）', async () => {
    const { sessionId, pid } = await startSession('echo READY; exec sleep 300');
    openedPids.push(pid);

    // node-pty 用 POSIX_SPAWN_SETSID/forkpty 建新会话：PTY 自成一组，宿主的组不在其中
    const pgid = (target: number) => execFileSync('ps', ['-o', 'pgid=', '-p', String(target)]).toString().trim();
    expect(pgid(pid)).not.toBe(pgid(process.pid));

    await ptyExecutor!.killPtySession(sessionId);

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
    await ptyExecutor!.killPtySession(sessionId);

    const startedAt = Date.now();
    await ptyExecutor!.killPtySession(sessionId);

    expect(Date.now() - startedAt).toBeLessThan(SHELL_KILL.POLL_INTERVAL_MS);
  }, 30000);
});

// **这一组永不跳过**：上面的真进程用例在 CI（无 node-pty 原生产物）上整组 skip，
// 收尸接线不能因此失守。守的是「PTY 真的在收尸清单里」——产品代码里零调用方的
// 收尸函数 = 白写（STOP1 的 cancelAll 就是前车之鉴）。
describe('PTY 收尸接线守护（不依赖原生模块）', () => {
  it('reapChildProcesses 收 PTY 会话，且停机属主把 pty 计数打进日志', () => {
    const root = join(__dirname, '../../../../src');
    const reaper = readFileSync(join(root, 'host/tools/shell/shutdownReaper.ts'), 'utf-8');
    expect(reaper, '收尸入口没收 PTY').toContain('reapPtySessions');
    expect(reaper, '收尸返回值没带 pty 计数').toContain('killedPtySessions');

    // 不留痕的步骤事后无法判断跑没跑过（本仓吃过 exitReason 看着完美、日志一行没打的亏）
    const webServer = readFileSync(join(root, 'web/webServer.ts'), 'utf-8');
    expect(webServer, '停机日志没带 pty 计数').toContain('pty session(s)');
  });

  it('killPtySession 返回 Promise（「已终止」要等确认退出，不能发完信号就返回）', () => {
    const source = readFileSync(
      join(__dirname, '../../../../src/host/tools/shell/ptyExecutor.ts'),
      'utf-8',
    );
    expect(source).toMatch(/export async function killPtySession/);
    expect(source, 'PTY 终止没走整树退出证明').toContain('killProcessTree');
  });
});
