// 子进程死活判定的回归钉子。
//
// 存在理由（2026-08-07）：acceptance smoke 里长期用 `child.exitCode !== null` 判活，
// 而被信号打死的子进程 exitCode 恒为 null。renderer hot-update smoke 在 CI 上撞
// better-sqlite3 的 V8 断言（SIGABRT）时就被这个谓词漏掉，空转 60 秒后报成
// 「timed out waiting for webServer」——真因（崩溃栈）被埋在输出里，报错说的是超时。
//
// 这里的断言就是防止有人把判定改回只看 exitCode。

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isChildGone,
  describeChildExit,
  isAbnormalExit,
} from '../../scripts/acceptance/childProcessState';

describe('childProcessState', () => {
  describe('isChildGone', () => {
    it('运行中 → false', () => {
      expect(isChildGone({ exitCode: null, signalCode: null })).toBe(false);
    });

    it('正常退出 → true', () => {
      expect(isChildGone({ exitCode: 0, signalCode: null })).toBe(true);
      expect(isChildGone({ exitCode: 1, signalCode: null })).toBe(true);
    });

    // ↓ 这条是本文件的核心：只看 exitCode 的实现会在这里挂
    it.each(['SIGABRT', 'SIGKILL', 'SIGTERM', 'SIGSEGV'] as const)(
      '被 %s 打死时 exitCode 仍为 null，但必须判定为已终止',
      (signal) => {
        expect(isChildGone({ exitCode: null, signalCode: signal })).toBe(true);
      },
    );
  });

  describe('describeChildExit', () => {
    it('退出码和信号都要出现，否则分不清 abort 和正常退出', () => {
      expect(describeChildExit({ exitCode: null, signalCode: 'SIGABRT' }))
        .toBe('exitCode=- signal=SIGABRT');
      expect(describeChildExit({ exitCode: 1, signalCode: null }))
        .toBe('exitCode=1 signal=-');
    });

    it('运行中给出明确措辞而不是空串', () => {
      expect(describeChildExit({ exitCode: null, signalCode: null })).toBe('still running');
    });
  });

  describe('isAbnormalExit', () => {
    it('干净退出 / 我们发的 SIGTERM → 不算异常', () => {
      expect(isAbnormalExit({ exitCode: 0, signalCode: null })).toBe(false);
      expect(isAbnormalExit({ exitCode: null, signalCode: 'SIGTERM' })).toBe(false);
    });

    it('崩溃信号与非零退出码 → 算异常，必须留证据', () => {
      expect(isAbnormalExit({ exitCode: null, signalCode: 'SIGABRT' })).toBe(true);
      expect(isAbnormalExit({ exitCode: null, signalCode: 'SIGSEGV' })).toBe(true);
      expect(isAbnormalExit({ exitCode: 1, signalCode: null })).toBe(true);
    });

    it('还在跑 → 不算异常', () => {
      expect(isAbnormalExit({ exitCode: null, signalCode: null })).toBe(false);
    });
  });

  // 真起一个进程让它 abort，确认 Node 的实际行为与上面的假对象一致
  // （否则这批断言只是在测我自己编的数据形状）。
  it('真实 abort 的子进程：exitCode 为 null、signalCode 为 SIGABRT', async () => {
    const child = spawn(process.execPath, ['-e', 'process.abort()'], { stdio: 'ignore' });
    await once(child, 'exit');

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe('SIGABRT');
    expect(isChildGone(child)).toBe(true);
    expect(isAbnormalExit(child)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 静态契约：全仓不准再出现裸判活谓词。
//
// 上面那组断言只钉住 helper 自己的行为，钉不住「有人在新脚本里又写一遍
// child.exitCode !== null」——这条病在本仓被复制粘贴过 24 处（#1019 修 1 个、
// #1042 修 3 个、#1045 修 2 个、本批修 21 个），每一处都是独立写出来的。
// 没有这道门，第 25 处只是时间问题。
//
// 零豁免机制：唯一的排除是 helper 定义文件自身。不设行内标记、不设文件名
// 白名单——按名字枚举的清单是漏洞制造机，新文件会默认漏过去。
// 真有必须裸写的场合，就把那处也收进 childProcessState.ts。
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_DIRS = ['scripts/acceptance', 'scripts/perf'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs']);
/** helper 的定义处必然含这个模式，是唯一排除项。 */
const DEFINITION_FILE = 'scripts/acceptance/childProcessState.ts';
const BARE_PREDICATE = /exitCode\s*[!=]==?\s*null/;

function collectScannedFiles(): string[] {
  const found: string[] = [];
  for (const dir of SCAN_DIRS) {
    const absDir = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const entry of fs.readdirSync(absDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
      const rel = path
        .relative(REPO_ROOT, path.join(entry.parentPath ?? absDir, entry.name))
        .split(path.sep)
        .join('/');
      if (rel === DEFINITION_FILE) continue;
      found.push(rel);
    }
  }
  return found.sort();
}

describe('判活谓词静态契约', () => {
  const scanned = collectScannedFiles();

  // fail-loud：glob 写错扫到 0 个文件时，下面那条断言会「全绿」但什么都没验。
  // 这条让扫描范围本身也是被断言的对象。
  it('扫描范围非空（否则下面那条零违规是假绿）', () => {
    expect(scanned.length, `扫描 ${SCAN_DIRS.join(' / ')} 只找到 ${scanned.length} 个文件`)
      .toBeGreaterThan(30);
  });

  it('没有任何脚本裸用 exitCode 判活（应改 import isChildGone）', () => {
    const violations: string[] = [];
    for (const rel of scanned) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (BARE_PREDICATE.test(line)) violations.push(`${rel}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(
      violations,
      `裸判活谓词会把「被信号打死」误判成「还在跑」。改用 ${DEFINITION_FILE} 的 isChildGone：\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
