import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class MockDatabase {},
}));

import {
  DatabaseService,
  onDatabaseRecovered,
} from '../../../src/host/services/core/databaseService';
import {
  getPersistenceHealth,
  setDbAvailable,
} from '../../../src/web/helpers/sessionCache';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setDbAvailable(false, new Error('test reset'));
});

describe('DatabaseService retry recovery', () => {
  it('re-marks persistence durable after a retry initializes the database', async () => {
    vi.useFakeTimers();
    setDbAvailable(false, new Error('initial failure'));
    const unsubscribe = onDatabaseRecovered(() => {
      setDbAvailable(true);
    });

    const db = new DatabaseService();
    const doInitialize = vi.spyOn(
      db as unknown as { _doInitialize: () => Promise<void> },
      '_doInitialize',
    );
    doInitialize
      .mockRejectedValueOnce(new Error('transient init failure'))
      .mockResolvedValueOnce(undefined);

    try {
      await expect(db.initialize()).rejects.toThrow('transient init failure');
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      unsubscribe();
    }

    expect(getPersistenceHealth()).toMatchObject({
      status: 'available',
      mode: 'database',
      durable: true,
    });
  });

  it('can initialize again after close clears the finished init promise', async () => {
    const db = new DatabaseService();
    const close = vi.fn();
    let initialized = 0;
    vi.spyOn(db as unknown as { _doInitialize: () => Promise<void> }, '_doInitialize').mockImplementation(
      async () => {
        initialized++;
        (db as unknown as { db: { close: () => void } | null }).db = { close };
      },
    );

    await db.initialize();
    db.close();
    await db.initialize();

    expect(initialized).toBe(2);
    expect(close).toHaveBeenCalledOnce();
    expect(db.isReady).toBe(true);
  });
});
