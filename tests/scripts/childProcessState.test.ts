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
