import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  captureLoopOwnerStamp,
  parseLoopOwnerStamp,
  resolveLoopOwnerLiveness,
  stripLoopOwnerStamp,
  type LoopOwnershipProbes,
} from '../../../src/host/loop/loopOwnership';
import type { SessionAutomationOwnerIdentity } from '../../../src/shared/contract/sessionAutomation';

/** 身份读数可用的平台；win32 无口径 → 判活退化为存在性检查。 */
const IDENTITY_PLATFORMS = new Set(['darwin', 'linux']);

/** 真死的 pid：spawnSync 等待退出并收尸，返回的 pid 已确认不存在。 */
function deadOwnerPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
  if (!child.pid) throw new Error('failed to spawn a short-lived child for a dead pid');
  return child.pid;
}

const probes = (overrides: Partial<LoopOwnershipProbes>): LoopOwnershipProbes => ({
  isPidAlive: () => true,
  readProcessIdentity: () => null,
  ...overrides,
});

describe('校时免疫（判据：身份读数与日期时钟无关，wall clock 跳变不误杀活进程）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 身份读数来自真实子进程/内核（走真实时钟），vitest 只拨快本进程的 Date——
  // 模拟「系统校时 ±60s、归属进程本身还活着」。修复前用 Date.now() - etime 反推
  // 启动时间，校时会把推算值整体漂出容差，活进程被判 dead（触发中断收口+通知）。
  for (const stepMs of [60_000, -60_000]) {
    it(`系统时间${stepMs > 0 ? '向前' : '向后'}校 60s：同一活进程仍判 alive、不收口`, () => {
      const stamp = captureLoopOwnerStamp();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + stepMs);
      expect(resolveLoopOwnerLiveness(stamp)).toBe('alive');
    });
  }
});

describe('resolveLoopOwnerLiveness（判据：只对「已确认消失」动手）', () => {
  it('无戳 / pid 非法 → unknown（判不出归属就不动手）', () => {
    expect(resolveLoopOwnerLiveness(null, probes({}))).toBe('unknown');
    expect(resolveLoopOwnerLiveness({ pid: 0, stampedAt: 1 }, probes({}))).toBe('unknown');
    expect(resolveLoopOwnerLiveness({ pid: -2, stampedAt: 1 }, probes({}))).toBe('unknown');
  });

  it('pid 不存在（ESRCH）→ dead', () => {
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processIdentity: { source: 'darwin-ps-lstart', value: 1_000 }, stampedAt: 1 },
      probes({ isPidAlive: () => false }),
    )).toBe('dead');
  });

  it('pid 在 + 无身份（win32 / 旧版 processStartAtMs 戳）→ alive（存在性优先，漏收方向）', () => {
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, stampedAt: 1 },
      probes({ isPidAlive: () => true }),
    )).toBe('alive');
  });

  it('pid 在 + 身份同源同值 → alive；同源异值（pid 复用）→ dead', () => {
    const identity: SessionAutomationOwnerIdentity = { source: 'darwin-ps-lstart', value: 1_788_692_082_000 };
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processIdentity: identity, stampedAt: 1 },
      probes({ readProcessIdentity: () => ({ ...identity }) }),
    )).toBe('alive');
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processIdentity: identity, stampedAt: 1 },
      probes({ readProcessIdentity: () => ({ source: 'darwin-ps-lstart', value: identity.value + 86_400_000 }) }),
    )).toBe('dead'); // 启动读数差一天 = 该 pid 现在属于另一个进程
  });

  it('身份确认不了 ⇒ alive：读不到身份 / 跨口径（source 不同）都判不准，不误杀', () => {
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processIdentity: { source: 'darwin-ps-lstart', value: 1 }, stampedAt: 1 },
      probes({ readProcessIdentity: () => null }),
    )).toBe('alive');
    expect(resolveLoopOwnerLiveness(
      { pid: 4242, processIdentity: { source: 'linux-proc-stat-starttime', value: 12345 }, stampedAt: 1 },
      probes({ readProcessIdentity: () => ({ source: 'darwin-ps-lstart', value: 12345 }) }),
    )).toBe('alive');
  });
});

describe('parseLoopOwnerStamp', () => {
  it('解析合法戳（含身份）；身份字段坏按无身份收（退化为存在性检查）', () => {
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":123,"processIdentity":{"source":"darwin-ps-lstart","value":456},"stampedAt":789}}'))
      .toEqual({ pid: 123, processIdentity: { source: 'darwin-ps-lstart', value: 456 }, stampedAt: 789 });
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":123,"stampedAt":789}}'))
      .toEqual({ pid: 123, stampedAt: 789 });
    // 旧版戳（processStartAtMs，Date.now()-etime 反推值）能解析出 pid；身份按缺省。
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":123,"processStartAtMs":456,"stampedAt":789}}'))
      .toEqual({ pid: 123, stampedAt: 789 });
    // 未知口径 / value 非数 → 身份不可信，按无身份收。
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":123,"processIdentity":{"source":"yesterday","value":1},"stampedAt":789}}'))
      .toEqual({ pid: 123, stampedAt: 789 });
    expect(parseLoopOwnerStamp('{"ownerProcess":{"pid":123,"processIdentity":{"source":"darwin-ps-lstart","value":"x"},"stampedAt":789}}'))
      .toEqual({ pid: 123, stampedAt: 789 });
  });

  it('无 ownerProcess / 坏 JSON / pid 不合法 → null', () => {
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

describe('真实进程判活（default probes）', () => {
  it('本进程的戳 → alive；真死的子进程 pid → dead', () => {
    expect(resolveLoopOwnerLiveness(captureLoopOwnerStamp())).toBe('alive');

    const deadPid = deadOwnerPid();
    expect(resolveLoopOwnerLiveness({ pid: deadPid, stampedAt: 1 })).toBe('dead');
  });

  it.skipIf(!IDENTITY_PLATFORMS.has(process.platform))(
    'pid 复用判定（身份平台）：pid 在但启动身份对不上 → dead',
    () => {
      const { pid, processIdentity } = captureLoopOwnerStamp();
      if (!processIdentity) throw new Error('owner identity unavailable on this platform');
      // 同一进程的身份读数恒定；偏 1 个最小单位 = 该 pid 现在属于另一个进程。
      expect(resolveLoopOwnerLiveness({
        pid,
        processIdentity: { source: processIdentity.source, value: processIdentity.value + 1 },
        stampedAt: 1,
      })).toBe('dead');
    },
  );
});
