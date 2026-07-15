import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureUpdateServiceInitialized } from '../../../../src/host/app/updateServiceBootstrap';
import { getUpdateService, isUpdateServiceInitialized } from '../../../../src/host/services/cloud/updateService';

const root = path.resolve(import.meta.dirname, '../../../..');

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('shared UpdateService bootstrap', () => {
  it('is idempotent without a mainWindow event sink', () => {
    vi.useFakeTimers();
    const configService = {
      getSettings: () => ({ cloudApi: { url: 'https://updates.test' } }),
    };

    const first = ensureUpdateServiceInitialized(configService as never);
    const second = ensureUpdateServiceInitialized(configService as never);

    expect(second).toBe(first);
    expect(isUpdateServiceInitialized()).toBe(true);
    expect(getUpdateService()).toBe(first);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('initializes the packaged web-host path after ConfigService and before IPC handlers', () => {
    const source = readFileSync(path.join(root, 'src/web/webServer.ts'), 'utf8');
    const configReady = source.indexOf('await configService.initialize()');
    const updateReady = source.indexOf('ensureUpdateServiceInitialized(configService', configReady);
    const handlers = source.indexOf('registerHandlers();', updateReady);

    expect(configReady).toBeGreaterThan(0);
    expect(updateReady).toBeGreaterThan(configReady);
    expect(handlers).toBeGreaterThan(updateReady);
  });
});
