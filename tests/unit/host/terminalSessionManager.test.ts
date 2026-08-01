// TerminalSessionManager —— 会话级长生命周期 PTY 的生命周期契约。
//
// 这套测试的重点不是「能不能开终端」，而是**它不能有 ptyExecutor 的那套超时语义**：
// 用户挂着的登录态 shell 被后台清理杀掉，是本批调研列的第一条反面教材。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface FakePty {
  pid: number;
  killed: boolean;
  written: string[];
  cols: number;
  rows: number;
  emitData: (data: string) => void;
  emitExit: (code: number) => void;
  spawnArgs: { shell: string; args: string[]; cwd: string };
}

const spawned: FakePty[] = [];
let nextPid = 1000;

vi.mock('node-pty', () => ({
  spawn: (shell: string, args: string[], opts: { cwd: string; cols: number; rows: number }) => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const fake: FakePty = {
      pid: (nextPid += 1),
      killed: false,
      written: [],
      cols: opts.cols,
      rows: opts.rows,
      spawnArgs: { shell, args, cwd: opts.cwd },
      emitData: (data) => onData(data),
      emitExit: (code) => onExit({ exitCode: code }),
    };
    spawned.push(fake);
    return {
      pid: fake.pid,
      onData: (cb: (d: string) => void) => { onData = cb; },
      onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb; },
      write: (d: string) => fake.written.push(d),
      kill: () => { fake.killed = true; },
      resize: (cols: number, rows: number) => { fake.cols = cols; fake.rows = rows; },
    };
  },
}));

// `ps` 的返回值是收割判据，必须能在测试里摆布；静态 import 的绑定 spy 不动，所以整模块替换。
const execFileSyncMock = vi.fn<(...args: unknown[]) => string>();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, default: actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-p0-'));
vi.mock('../../../src/host/config/configPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => tmpConfigDir };
});

const {
  __resetTerminalSessionsForTest,
  annotateTerminalSession,
  disposeTerminalSession,
  getTerminalSnapshot,
  listTerminalSessions,
  onTerminalOutput,
  openTerminalSession,
  reapOrphanTerminals,
  resizeTerminalSession,
  writeToTerminalSession,
} = await import('../../../src/host/services/terminal/terminalSessionManager');

beforeEach(() => {
  spawned.length = 0;
  __resetTerminalSessionsForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('terminal session lifecycle', () => {
  it('spawns an interactive shell bound to the chat session', () => {
    const snapshot = openTerminalSession({ sessionId: 's1', cwd: '/tmp/work' });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].spawnArgs.cwd).toBe('/tmp/work');
    // -c 是一次性命令的形态；交互 shell 必须不带它，否则用户根本没法在里面敲东西。
    expect(spawned[0].spawnArgs.args).not.toContain('-c');
    expect(snapshot.alive).toBe(true);
    expect(snapshot.sessionId).toBe('s1');
  });

  it('re-attaches to the same pty instead of spawning a second one', () => {
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });
    spawned[0].emitData('hello\r\n');
    const reattached = openTerminalSession({ sessionId: 's1', cwd: '/tmp' });

    expect(spawned).toHaveLength(1);
    expect(reattached.data).toContain('hello');
  });

  it('keeps one pty per chat session', () => {
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });
    openTerminalSession({ sessionId: 's2', cwd: '/tmp' });

    spawned[0].emitData('from-one');
    spawned[1].emitData('from-two');

    expect(getTerminalSnapshot('s1')?.data).toBe('from-one');
    expect(getTerminalSnapshot('s2')?.data).toBe('from-two');
    expect(listTerminalSessions().map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('does NOT kill a long-lived session on any timer (ptyExecutor 的 10 分钟超时不得复用)', () => {
    vi.useFakeTimers();
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });

    // 远超 ptyExecutor 的 PTY_DEFAULT_TIMEOUT(10min) 与 PTY_CLEANUP_INTERVAL(1min)
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(spawned[0].killed).toBe(false);
    expect(getTerminalSnapshot('s1')?.alive).toBe(true);
  });

  it('kills the pty and drops the session on dispose', () => {
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });
    expect(disposeTerminalSession('s1')).toBe(true);

    expect(spawned[0].killed).toBe(true);
    expect(getTerminalSnapshot('s1')).toBeNull();
  });

  it('marks the session dead when the shell exits', () => {
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });
    spawned[0].emitExit(0);

    expect(getTerminalSnapshot('s1')?.alive).toBe(false);
    expect(writeToTerminalSession('s1', 'ls\n').ok).toBe(false);
  });

  it('forwards resize to the pty', () => {
    openTerminalSession({ sessionId: 's1', cwd: '/tmp', cols: 80, rows: 24 });
    resizeTerminalSession('s1', 120, 40);

    expect(spawned[0].cols).toBe(120);
    expect(getTerminalSnapshot('s1')?.rows).toBe(40);
  });
});

describe('output buffer', () => {
  it('streams output to listeners and accumulates a re-attach snapshot', () => {
    const seen: string[] = [];
    onTerminalOutput((sessionId, data) => { if (sessionId === 's1') seen.push(data); });
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });

    spawned[0].emitData('a');
    spawned[0].emitData('b');

    expect(seen).toEqual(['a', 'b']);
    expect(getTerminalSnapshot('s1')?.data).toBe('ab');
  });

  it('caps the ring buffer so a chatty process cannot grow host memory without bound', () => {
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 10; i += 1) spawned[0].emitData(chunk);

    const size = getTerminalSnapshot('s1')?.data.length ?? 0;
    expect(size).toBeLessThanOrEqual(256 * 1024);
    expect(size).toBeGreaterThan(0);
  });

  it('annotate shows text in the terminal without feeding it to the shell', () => {
    const seen: string[] = [];
    onTerminalOutput((_id, data) => seen.push(data));
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });

    annotateTerminalSession('s1', '[Neo] ls -la\r\n');

    expect(seen).toContain('[Neo] ls -la\r\n');
    expect(getTerminalSnapshot('s1')?.data).toContain('[Neo]');
    // 关键：注解只进画面，不进 stdin——否则回显本身会被 shell 当成命令执行。
    expect(spawned[0].written).toEqual([]);
  });
});

describe('orphan pty reaping', () => {
  const pidFile = path.join(tmpConfigDir, 'terminal-pids.json');

  it('kills a recorded pid that is still the same shell', () => {
    fs.writeFileSync(pidFile, JSON.stringify([{ pid: 424242, shell: '/bin/zsh' }]));
    execFileSyncMock.mockReturnValue('/bin/zsh\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(reapOrphanTerminals()).toBe(1);
    expect(kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it('leaves a reused pid alone when the process is no longer our shell', () => {
    fs.writeFileSync(pidFile, JSON.stringify([{ pid: 424243, shell: '/bin/zsh' }]));
    execFileSyncMock.mockReturnValue('Google Chrome\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(reapOrphanTerminals()).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it('leaves alone the terminals of another host process that is still running', () => {
    // 同一个 data dir 被两个 host 同时用（已知问题，互斥锁另有工单）。后起的那个不能
    // 把先起那个正在用的终端当孤儿收了——用户会看到终端凭空全死。
    // owner 用一个确定活着的 pid：当前进程自己不行（会被判成「就是我」），用 init(1)。
    fs.writeFileSync(pidFile, JSON.stringify([{ pid: 424244, shell: '/bin/zsh', ownerPid: 1 }]));
    execFileSyncMock.mockReturnValue('/bin/zsh\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(reapOrphanTerminals()).toBe(0);
    expect(kill).not.toHaveBeenCalledWith(424244, 'SIGKILL');
    // 账不能被抹平：它还是别人的，下次仍要认得出来。
    const remaining = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as Array<{ pid: number }>;
    expect(remaining.map((entry) => entry.pid)).toEqual([424244]);
  });

  it('reaps a pid whose owning host process is gone', () => {
    fs.writeFileSync(pidFile, JSON.stringify([{ pid: 424245, shell: '/bin/zsh', ownerPid: 999999 }]));
    execFileSyncMock.mockReturnValue('/bin/zsh\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
      if (pid === 999999 && signal === 0) throw new Error('ESRCH');
      return true;
    });

    expect(reapOrphanTerminals()).toBe(1);
    expect(kill).toHaveBeenCalledWith(424245, 'SIGKILL');
  });

  it('records live pids so the next startup can find orphans', () => {
    openTerminalSession({ sessionId: 's1', cwd: '/tmp' });
    const persisted = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as Array<{ pid: number }>;
    expect(persisted.map((entry) => entry.pid)).toContain(spawned[0].pid);
  });
});
