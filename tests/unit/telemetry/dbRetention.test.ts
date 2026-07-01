import { describe, expect, it, vi } from 'vitest';
import { runDbRetention, shouldRunVacuum } from '../../../src/host/services/infra/dbRetention';
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

describe('runDbRetention', () => {
  it('总是调用 pruneAgedTelemetry(now)', async () => {
    const storage = fakeStorage();
    await runDbRetention({
      now: NOW, storage,
      vacuum: vi.fn(), readLastVacuumAt: () => NOW, writeLastVacuumAt: vi.fn(),
    });
    expect(storage.pruneAgedTelemetry).toHaveBeenCalledWith(NOW);
  });

  it('距上次 VACUUM 过久时执行 VACUUM 并记录时间戳', async () => {
    const storage = fakeStorage();
    const vacuum = vi.fn();
    const writeLastVacuumAt = vi.fn();
    const result = await runDbRetention({
      now: NOW, storage, vacuum,
      readLastVacuumAt: () => null, writeLastVacuumAt,
    });
    expect(vacuum).toHaveBeenCalledOnce();
    expect(writeLastVacuumAt).toHaveBeenCalledWith(NOW);
    expect(result.vacuumed).toBe(true);
  });

  it('距上次 VACUUM 未到间隔则跳过 VACUUM', async () => {
    const storage = fakeStorage();
    const vacuum = vi.fn();
    const result = await runDbRetention({
      now: NOW, storage, vacuum,
      readLastVacuumAt: () => NOW - 1000, writeLastVacuumAt: vi.fn(),
    });
    expect(vacuum).not.toHaveBeenCalled();
    expect(result.vacuumed).toBe(false);
  });

  it('DB 不可用时跳过 VACUUM,不抛', async () => {
    const storage = fakeStorage(false);
    const vacuum = vi.fn();
    await expect(runDbRetention({
      now: NOW, storage, vacuum,
      readLastVacuumAt: () => null, writeLastVacuumAt: vi.fn(),
    })).resolves.toBeDefined();
    expect(vacuum).not.toHaveBeenCalled();
  });

  it('VACUUM 抛错不冒泡(best-effort)', async () => {
    const storage = fakeStorage();
    await expect(runDbRetention({
      now: NOW, storage,
      vacuum: () => { throw new Error('locked'); },
      readLastVacuumAt: () => null, writeLastVacuumAt: vi.fn(),
    })).resolves.toBeDefined();
  });
});
