import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  captureLoopOwnerStamp,
  parseLoopOwnerStamp,
  resolveLoopOwnerLiveness,
  stripLoopOwnerStamp,
  type LoopOwnershipProbes,
} from '../../../src/host/loop/loopOwnership';

const PS_ETIME_PLATFORMS = new Set(['darwin', 'linux']);

/** 真死的 pid：spawnSync 等待退出并收尸，返回的 pid 已确认不存在。 */
function deadOwnerPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
  if (!child.pid) throw new Error('failed to spawn a short-lived child for a dead pid');
  return child.pid;
}

const probes = (overrides: Partial<LoopOwnershipProbes>): LoopOwnershipProbes => ({
  isPidAlive: () => true,
  readProcessEtime: () => null,
  ...overrides,
});

describe('ps etime 解析（经 resolveLoopOwnerLiveness 注入探针覆盖；解析器不单独导出）', () => {
  // parsePsEtime 是模块私有。注入 etime 原文、按「正确换算值」预制 owner 戳：
  // 解析把该形态读错 ≥1 分钟（如 mm:ss 当 hh:mm、丢天数）就会落出 ±5s 容差变 dead。
  it('[[dd-]hh:]mm:ss 三种形态换算正确 → alive；按偏 60s 的值预制 → dead', () => {
    const cases: Array<[etime: string, elapsedMs: number]> = [
      ['90:24', (90 * 60 + 24) * 1000],
      ['04:05:06', ((4 * 60) + 5) * 60_000 + 6_000],
      ['2-03:04:05', (((2 * 24 + 3) * 60) + 4) * 60_000 + 5_000],
    ];
    for (const [etime, elapsedMs] of cases) {
      expect(resolveLoopOwnerLiveness(
        { pid: 4242, processStartAtMs: Date.now() - elapsedMs, stampedAt: 1 },
        probes({ readProcessEtime: () => etime }),
      )).toBe('alive');
      // 校准：同一解析、戳偏 60s → dead，证明容差窗口真能抓分钟级换算错误
      expect(resolveLoopOwnerLiveness(
        { pid: 4242, processStartAtMs: Date.now() - elapsedMs + 60_000, stampedAt: 1 },
        probes({ readProcessEtime: () => etime }),
      )).toBe('dead');
    }
  });

  it('不认识的格式（空串 / yesterday / 12:）判不准 → alive（不动手，漏收方向）', () => {
    for (const badEtime of ['', 'yesterday', '12:']) {
      expect(resolveLoopOwnerLiveness(
        { pid: 4242, processStartAtMs: 1, stampedAt: 1 },
        probes({ readProcessEtime: () => badEtime }),
      )).toBe('alive');
    }
  });
});

describe('parseLoopOwnerStamp', () => {
  it('解析合法戳；无 ownerProcess / 坏 JSON / pid 不合法都返回 null', () => {
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":123,"processStartAtMs":456,"stampedAt":789}}'))
      .toEqual({ pid: 123, processStartAtMs: 456, stampedAt: 789 });
    expect(parseLoopOwnerStamp('{}')).toBeNull();
    expect(parseLoopOwnerStamp(null)).toBeNull();
    expect(parseLoopOwnerStamp('{bad json')).toBeNull();
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":"x"}}')).toBeNull();
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":0}}')).toBeNull();
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":1.5}}')).toBeNull();
  });
});

describe('stripLoopOwnerStamp', () => {
  it('摘掉 ownerProcess 保留其余键；坏输入原样返回', () => {
    expect(stripLoopOwnerStamp('{"prompt":"p","ownerProcess":{"pid":1},"until":"u"}'))
      .toBe('{"prompt":"p","until":"u"}');
    expect(stripLoopOwnerStamp('{bad json')).toBe('{bad json');
    expect(stripLoopOwnerStamp(null)).toBeNull();
  });
});

describe('resolveLoopOwnerLiveness（判据：只对「已确认消失」动手）', () => {
  it('无戳 / pid 非法 → unknown（判不出归属就不动手）', () => {
    expect(resolveLoopOwnerLiveness(null, probes({}))).toBe('unknown');
    expect(resolveLoopOwnerLiveness({ pid: 0, stampedAt: 1 }, probes({}))).toBe('unknown');
    expect(resolveLoopOwnerLiveness({ pid: -2, stampedAt: 1 }, probes({}))).toBe('unknown');
  });

  it('pid 不存在（ESRCH）→ dead', () => {
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processStartAtMs: 1_000, stampedAt: 1 },
      probes({ isPidAlive: () => false }),
    )).toBe('dead');
  });

  it('pid 在 + 无启动时间（win32 等退化路径）→ alive（存在性优先，漏收方向）', () => {
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, stampedAt: 1 },
      probes({ isPidAlive: () => true }),
    )).toBe('alive');
  });

  it('pid 在 + 启动时间吻合 → alive；对不上（pid 复用）→ dead', () => {
    const aliveProbes = probes({ isPidAlive: () => true, readProcessEtime: () => '0:00:02' });
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processStartAtMs: Date.now() - 2_000, stampedAt: 1 },
      aliveProbes,
    )).toBe('alive'); // 2s 偏差在容差内
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processStartAtMs: 60_000, stampedAt: 1 },
      aliveProbes,
    )).toBe('dead'); // 1970 年的戳 vs now-2s = 不是同一个进程
  });

  it('pid 在 + 当前启动时间读不到 → alive（保守，不误杀）', () => {
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processStartAtMs: 60_000, stampedAt: 1 },
      probes({ isPidAlive: () => true, readProcessEtime: () => null }),
    )).toBe('alive');
  });
});

describe('真实进程判活（default probes）', () => {
  it('本进程的戳 → alive；真死的子进程 pid → dead', () => {
    expect(resolveLoopOwnerLiveness(captureLoopOwnerStamp())).toBe('alive');

    const deadPid = deadOwnerPid();
    expect(resolveLoopOwnerLiveness({ pid: deadPid, stampedAt: 1 })).toBe('dead');
  });

  it.skipIf(!PS_ETIME_PLATFORMS.has(process.platform))(
    'pid 复用判定（ps etime 平台）：pid 在但启动时间对不上 → dead',
    () => {
      const stamp = captureLoopOwnerStamp();
      expect(stamp.processStartAtMs).toBeGreaterThan(0);
      // 戳里写一个错开 24h 的启动时间 = 该 pid 现在属于另一个进程。
      expect(resolveLoopOwnerLiveness({
        pid: stamp.pid,
        processStartAtMs: (stamp.processStartAtMs ?? 0) - 24 * 3600 * 1000,
        stampedAt: 1,
      })).toBe('dead');
    },
  );
});
