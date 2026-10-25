// ============================================================================
// daemonLock win32 半边单测（N-RESIDENT-HOST-SHELL-WIN-ATTACH · LOGIC half）。
//   - WEB_DAEMON.WINDOWS_LOCK_ENABLED 被 vi.mock 翻成 true（真常量保持 false，
//     翻转动作归 WIN-ATTACH-REALDEVICE；开关关闭期间的行为由 daemonLock.test.ts
//     的「win32：不取锁也不执行锁」组钉住）。
//   - 身份源走 PowerShell CIM 探针：child_process 只 mock execFileSync（daemonLock
//     唯一的子进程调用），spawn 透传真实现（造死 pid 用）。
//   - 夹具是文档口径的 PowerShell 输出形状（'o' 档 ISO-8601 + 空格 + CommandLine），
//     不是真机抓取——REALDEVICE 在真 Windows 机上复验。
// 驱动面只用公开入口（acquire/inspect/release），解析器与探针脚本经它们被咬合。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  acquireDaemonLock,
  inspectDaemonPid,
  isDaemonLockSupported,
  releaseDaemonLock,
} from '../../../../../src/host/services/daemon/daemonLock';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // daemonLock 唯一的子进程调用；测试里按用例喂 PowerShell 探针夹具
    execFileSync: vi.fn<(file: string, args: readonly string[]) => string>(),
  };
});

vi.mock('../../../../../src/shared/constants/webServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/shared/constants/webServer')>();
  return {
    ...actual,
    WEB_DAEMON: { ...actual.WEB_DAEMON, WINDOWS_LOCK_ENABLED: true },
  };
});

const WIN_TS = '2026-10-23T08:15:42.1234567Z';
const WIN_NODE_LINE
  = `${WIN_TS} "C:\\Program Files\\Agent Neo\\resources\\node.exe" `
    + 'C:\\Users\\x\\AppData\\Local\\com.linchen.code-agent\\resources\\webServer.cjs';
/** 与实现同字面（钉探针字符串；Rust 侧 resident_host_windows.rs 有同一断言）。 */
const PROBE_SCRIPT = (pid: number): string =>
  `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + ' ' + $p.CommandLine }`;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-lock-win-'));
  tempDirs.push(dir);
  return dir;
}

function writePidRecord(dataDir: string, pid: number, startTime: string | null): void {
  fs.writeFileSync(path.join(dataDir, 'daemon.pid'), JSON.stringify({ pid, startTime }));
}

/** 起一个立即退出的子进程，拿一个保证已死的 pid。 */
function spawnDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid!));
  });
}

/** 当前平台切成 win32；返回还原函数。 */
function stubWin32(): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true });
}

/** 把探针夹具接进 execFileSync mock（默认成功返回 node.exe 守护行）。 */
function stubProbe(output: string | Error = WIN_NODE_LINE): void {
  vi.mocked(execFileSync).mockReset();
  if (output instanceof Error) {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw output;
    });
  } else {
    vi.mocked(execFileSync).mockReturnValue(output);
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('win32 + WINDOWS_LOCK_ENABLED=true：锁生效，身份源是 PowerShell 探针', () => {
  beforeEach(() => stubProbe());

  it('isDaemonLockSupported：win32 为真（开关翻开后的判据）', () => {
    const restore = stubWin32();
    try {
      expect(isDaemonLockSupported()).toBe(true);
    } finally {
      restore();
    }
  });

  it('探针调用形状：powershell -NoProfile -NonInteractive -Command <镜像脚本>，不走 ps', () => {
    const restore = stubWin32();
    try {
      stubProbe();
      inspectDaemonPid({ pid: process.pid, startTime: WIN_TS });
      expect(execFileSync).toHaveBeenCalledWith('powershell', ['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT(process.pid)], expect.anything());
      // win32 下不得回落到 unix 的 ps（身份源单一，混用会拿错形状的输出）
      expect(vi.mocked(execFileSync).mock.calls.some(([file]) => file === 'ps')).toBe(false);
    } finally {
      restore();
    }
  });

  it('四态判别（Windows 夹具）：owned / foreign(标记不符) / foreign(非 node) / unknown(无身份)', () => {
    const restore = stubWin32();
    try {
      // 活 pid（本进程）+ creation time 吻合 + 命令行含 node.exe → owned
      stubProbe(WIN_NODE_LINE);
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('owned');

      // creation time 不同（pid 已被复用）→ foreign
      expect(inspectDaemonPid({ pid: process.pid, startTime: '2020-01-02T03:04:05.0000000Z' })).toBe('foreign');

      // 标记吻合但镜像不是 node（pid 归了别的进程）→ foreign
      stubProbe(`${WIN_TS} C:\\Windows\\System32\\msedgewebview2.exe --type=renderer`);
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('foreign');

      // CommandLine 为 null（探针只吐时间戳 + 空格）→ 身份未知 → unknown（让位，fail-closed）
      stubProbe(`${WIN_TS} `);
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('unknown');

      // 探针彻底失败（powershell 不在 / 权限）→ unknown
      stubProbe(new Error('spawn powershell ENOENT'));
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('unknown');

      // 无标记的旧版记录 → unknown
      stubProbe(WIN_NODE_LINE);
      expect(inspectDaemonPid({ pid: process.pid, startTime: null })).toBe('unknown');
    } finally {
      restore();
    }
  });

  it('镜像名大小写不敏感：NODE.EXE 也算 node 守护（win32 判据）', () => {
    const restore = stubWin32();
    try {
      stubProbe(`${WIN_TS} C:\\Tools\\NODE.EXE webServer.cjs`);
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('owned');
    } finally {
      restore();
    }
  });

  it('解析器夹具（经 inspectDaemonPid 驱动）：CRLF / 小数位变体可读，乱形状 fail-closed', () => {
    const restore = stubWin32();
    try {
      // CRLF：PowerShell 换行原文
      stubProbe(`${WIN_NODE_LINE}\r\n`);
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('owned');

      // 小数位变体：'o' 档固定 7 位，容忍 0-7 位（记录 startTime 与夹具一致即吻合）
      stubProbe('2026-10-23T08:15:42.1Z node.exe webServer.cjs');
      expect(inspectDaemonPid({ pid: process.pid, startTime: '2026-10-23T08:15:42.1Z' })).toBe('owned');
      stubProbe('2026-10-23T08:15:42Z node.exe webServer.cjs');
      expect(inspectDaemonPid({ pid: process.pid, startTime: '2026-10-23T08:15:42Z' })).toBe('owned');

      // 8 位小数：不成形状 → unknown
      stubProbe('2026-10-23T08:15:42.12345678Z node.exe webServer.cjs');
      expect(inspectDaemonPid({ pid: process.pid, startTime: '2026-10-23T08:15:42.12345678Z' })).toBe('unknown');

      // 空格代替 T / 丢 Z / PowerShell 报错文本 → unknown
      stubProbe('2026-10-23 08:15:42.1234567Z node.exe webServer.cjs');
      expect(inspectDaemonPid({ pid: process.pid, startTime: '2026-10-23 08:15:42.1234567Z' })).toBe('unknown');
      stubProbe('2026-10-23T08:15:42.1234567 node.exe webServer.cjs');
      expect(inspectDaemonPid({ pid: process.pid, startTime: '2026-10-23T08:15:42.1234567' })).toBe('unknown');
      stubProbe('Get-CimInstance : 拒绝访问。');
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('unknown');

      // 空输出（pid 不存在时 if ($p) 不成立）→ unknown
      stubProbe('');
      expect(inspectDaemonPid({ pid: process.pid, startTime: WIN_TS })).toBe('unknown');
    } finally {
      restore();
    }
  });
});

describe('win32 + WINDOWS_LOCK_ENABLED=true：acquire / release 走锁语义', () => {
  beforeEach(() => stubProbe());

  it('owned 持锁者在场：让位并拿到其 pid，不删不碰文件', () => {
    const dataDir = makeTempDir();
    const restore = stubWin32();
    try {
      writePidRecord(dataDir, process.pid, WIN_TS);
      expect(acquireDaemonLock(dataDir, 777)).toEqual({ acquired: false, existingPid: process.pid });
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.pid'), 'utf8')) as { pid: number };
      expect(raw.pid).toBe(process.pid);
    } finally {
      restore();
    }
  });

  it('creation time 不符 / 非 node 镜像（pid 已被复用）：接管重写', () => {
    const dataDir = makeTempDir();
    const restore = stubWin32();
    try {
      writePidRecord(dataDir, process.pid, '2020-01-02T03:04:05.0000000Z');
      expect(acquireDaemonLock(dataDir, 888)).toEqual({ acquired: true, pid: 888 });

      stubProbe(`${WIN_TS} C:\\Windows\\System32\\svchost.exe`);
      writePidRecord(dataDir, process.pid, WIN_TS);
      expect(acquireDaemonLock(dataDir, 999)).toEqual({ acquired: true, pid: 999 });
    } finally {
      restore();
    }
  });

  it('CommandLine 为 null（身份未知）：让位不抢——陌生活进程绝不接管', () => {
    const dataDir = makeTempDir();
    const restore = stubWin32();
    try {
      stubProbe(`${WIN_TS} `);
      writePidRecord(dataDir, process.pid, WIN_TS);
      expect(acquireDaemonLock(dataDir, 111)).toEqual({ acquired: false, existingPid: process.pid });
    } finally {
      restore();
    }
  });

  it('死 pid（陈旧锁）：接管', async () => {
    const dataDir = makeTempDir();
    const deadPid = await spawnDeadPid();
    const restore = stubWin32();
    try {
      writePidRecord(dataDir, deadPid, WIN_TS);
      expect(acquireDaemonLock(dataDir, 222)).toEqual({ acquired: true, pid: 222 });
    } finally {
      restore();
    }
  });

  it('持锁写入的 startTime 来自探针（pid 复用判别的数据面）', () => {
    const dataDir = makeTempDir();
    const restore = stubWin32();
    try {
      expect(acquireDaemonLock(dataDir, process.pid)).toEqual({ acquired: true, pid: process.pid });
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.pid'), 'utf8')) as { pid: number; startTime: string | null };
      expect(raw).toEqual({ pid: process.pid, startTime: WIN_TS });
    } finally {
      restore();
    }
  });

  it('release：本进程持锁且身份吻合才删；身份不符（接任者）不删', () => {
    const dataDir = makeTempDir();
    const restore = stubWin32();
    try {
      writePidRecord(dataDir, process.pid, WIN_TS);
      releaseDaemonLock(dataDir);
      expect(fs.existsSync(path.join(dataDir, 'daemon.pid'))).toBe(false);

      // 身份已对不上（pid 复用后的接任者）：迟到的 shutdown 回调删不掉
      writePidRecord(dataDir, process.pid, WIN_TS);
      stubProbe(`${WIN_TS} C:\\Windows\\System32\\svchost.exe`);
      releaseDaemonLock(dataDir);
      expect(fs.existsSync(path.join(dataDir, 'daemon.pid'))).toBe(true);
    } finally {
      restore();
    }
  });
});
