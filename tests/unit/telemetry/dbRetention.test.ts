import { describe, expect, it, vi } from 'vitest';
import { runDbRetention, shouldRunVacuum } from '../../../src/host/services/infra/dbRetention';
import { shouldPersistVacuumMarker } from '../../../src/host/services/infra/dbVacuumSubprocess';
import { TELEMETRY_RETENTION } from '../../../src/shared/constants';

const NOW = 1_800_000_000_000;

function fakeStorage(dbAvailable = true) {
  return {
    dbAvailable,
    pruneAgedTelemetry: vi.fn(),
  };
}

describe('shouldRunVacuum', () => {
  it('从未 VACUUM 过(lastVacuumAt=null)时返回 true', () => {
    expect(shouldRunVacuum(NOW, null)).toBe(true);
  });

  it('距上次超过节流间隔返回 true,未超过返回 false', () => {
    expect(shouldRunVacuum(NOW, NOW - TELEMETRY_RETENTION.VACUUM_MIN_INTERVAL_MS - 1)).toBe(true);
    expect(shouldRunVacuum(NOW, NOW - 1000)).toBe(false);
  });
});

describe('shouldPersistVacuumMarker', () => {
  // 标记落错 = 跳过被当成成功,下次启动直接不跑,库永远不回收。
  it('只有 completed 才落标记', () => {
    expect(shouldPersistVacuumMarker('completed')).toBe(true);
    for (const outcome of ['failed', 'skipped-low-disk', 'skipped-already-running', 'db-unavailable', 'not-due'] as const) {
      expect(shouldPersistVacuumMarker(outcome), outcome).toBe(false);
    }
  });
});

describe('runDbRetention', () => {
  it('总是调用 pruneAgedTelemetry(now)', async () => {
    const storage = fakeStorage();
    await runDbRetention({
      now: NOW, storage,
      vacuum: vi.fn().mockResolvedValue('completed'), readLastVacuumAt: () => NOW, writeLastVacuumAt: vi.fn(),
    });
    expect(storage.pruneAgedTelemetry).toHaveBeenCalledWith(NOW);
  });

  it('距上次 VACUUM 过久时执行 VACUUM 并记录时间戳', async () => {
    const storage = fakeStorage();
    const vacuum = vi.fn().mockResolvedValue('completed');
    const writeLastVacuumAt = vi.fn();
    const result = await runDbRetention({
      now: NOW, storage, vacuum,
      readLastVacuumAt: () => null, writeLastVacuumAt,
    });
    expect(vacuum).toHaveBeenCalledOnce();
    expect(writeLastVacuumAt).toHaveBeenCalledWith(NOW);
    expect(result.vacuum).toBe('completed');
  });

  it('距上次 VACUUM 未到间隔则跳过 VACUUM', async () => {
    const storage = fakeStorage();
    const vacuum = vi.fn();
    const result = await runDbRetention({
      now: NOW, storage, vacuum,
      readLastVacuumAt: () => NOW - 1000, writeLastVacuumAt: vi.fn(),
    });
    expect(vacuum).not.toHaveBeenCalled();
    expect(result.vacuum).toBe('not-due');
  });

  it('DB 不可用时跳过 VACUUM,不抛', async () => {
    const storage = fakeStorage(false);
    const vacuum = vi.fn();
    const result = await runDbRetention({
      now: NOW, storage, vacuum,
      readLastVacuumAt: () => null, writeLastVacuumAt: vi.fn(),
    });
    expect(vacuum).not.toHaveBeenCalled();
    expect(result.vacuum).toBe('db-unavailable');
  });

  it('VACUUM 抛错不冒泡(best-effort),且不落标记', async () => {
    const writeLastVacuumAt = vi.fn();
    const result = await runDbRetention({
      now: NOW, storage: fakeStorage(),
      vacuum: () => { throw new Error('locked'); },
      readLastVacuumAt: () => null, writeLastVacuumAt,
    });
    expect(result.vacuum).toBe('failed');
    expect(writeLastVacuumAt).not.toHaveBeenCalled();
  });

  // 前置检查跳过 ≠ 成功:落了标记就等于下一个节流周期内库都不会被回收。
  it.each(['failed', 'skipped-low-disk', 'skipped-already-running'] as const)(
    'VACUUM 结果为 %s 时不落 .last-vacuum 标记(下次启动再试)',
    async (outcome) => {
      const writeLastVacuumAt = vi.fn();
      const result = await runDbRetention({
        now: NOW, storage: fakeStorage(),
        vacuum: vi.fn().mockResolvedValue(outcome),
        readLastVacuumAt: () => null, writeLastVacuumAt,
      });
      expect(result.vacuum).toBe(outcome);
      expect(writeLastVacuumAt).not.toHaveBeenCalled();
    },
  );
});
