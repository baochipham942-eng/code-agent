import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  captureLoopOwnerStamp,
  parseLoopOwnerStamp,
  parsePsEtime,
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
  readProcessStartAtMs: () => null,
  ...overrides,
});

describe('parsePsEtime', () => {
  it('解析 [[dd-]hh:]mm:ss 三种形态', () => {
    expect(parsePsEtime('90:24')).toBe((90 * 60 + 24) * 1000);
    expect(parsePsEtime('04:05:06')).toBe(((4 * 60) + 5) * 60_000 + 6_000);
    expect(parsePsEtime('2-03:04:05')).toBe(((2 * 24 + 3) * 60 + 4) * 60_000 + 5_000);
  });

  it('不认识的格式返回 null', () => {
    expect(parsePsEtime('')).toBeNull();
    expect(parsePsEtime('yesterday')).toBeNull();
    expect(parsePsEtime('12:')).toBeNull();
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
    const aliveProbes = probes({ isPidAlive: () => true, readProcessStartAtMs: () => 10_000 });
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processStartAtMs: 12_000, stampedAt: 1 },
      aliveProbes,
    )).toBe('alive'); // 2s 偏差在容差内
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processStartAtMs: 60_000, stampedAt: 1 },
      aliveProbes,
    )).toBe('dead'); // 50s 偏差 = 不是同一个进程
  });

  it('pid 在 + 当前启动时间读不到 → alive（保守，不误杀）', () => {
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processStartAtMs: 60_000, stampedAt: 1 },
      probes({ isPidAlive: () => true, readProcessStartAtMs: () => null }),
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
