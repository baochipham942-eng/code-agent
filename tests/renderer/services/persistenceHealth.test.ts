import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describePersistenceBanner,
  fetchWebBuildInfo,
  getPersistenceWarningText,
  shouldShowPersistenceWarning,
} from '../../../src/renderer/services/persistenceHealth';
import type { BuildInfo, PersistenceHealth } from '../../../src/shared/contract';
import { SQLITE_INTEGRITY } from '../../../src/shared/constants';
import { zh } from '../../../src/renderer/i18n';

afterEach(() => {
  vi.unstubAllGlobals();
});

const unavailable = {
  status: 'unavailable',
  mode: 'memory',
  durable: false,
  message: '历史持久化不可用，当前只会话内有效。',
  checkedAt: 10,
} satisfies PersistenceHealth;

const available = {
  status: 'available',
  mode: 'database',
  durable: true,
  message: '历史会持久化到本机数据库。',
  checkedAt: 20,
} satisfies PersistenceHealth;

describe('persistence health renderer helpers', () => {
  it('shows warnings only for non-durable persistence', () => {
    expect(shouldShowPersistenceWarning(unavailable)).toBe(true);
    expect(shouldShowPersistenceWarning(available)).toBe(false);
    expect(shouldShowPersistenceWarning(null)).toBe(false);
  });

  it('shows a warning when persistence is degraded but still durable', () => {
    const degraded = {
      status: 'degraded',
      mode: 'database',
      durable: true,
      message: '历史会持久化到本机数据库。',
      reason: 'FTS_DISABLED',
      checkedAt: 30,
    } satisfies PersistenceHealth;
    expect(shouldShowPersistenceWarning(degraded)).toBe(true);
  });

  it('shows a warning after backup recovery', () => {
    const recovered = {
      status: 'recovered',
      mode: 'database',
      durable: true,
      message: 'Restored from a local backup.',
      reason: `${SQLITE_INTEGRITY.RECOVERED_FROM_BACKUP}:2026-09-14T00:00:00.000Z`,
      checkedAt: 40,
    } satisfies PersistenceHealth;
    expect(shouldShowPersistenceWarning(recovered)).toBe(true);
    expect(describePersistenceBanner(recovered, zh.settings.data.persistence)).toMatchObject({
      title: zh.settings.data.persistence.recoveredTitle,
      body: expect.stringContaining('2026-09-14T00:00:00.000Z'),
    });
  });

  it('translates DB_CORRUPT_NO_BACKUP instead of leaking a host message', () => {
    const noBackup = {
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      message: 'Restored from a local backup.',
      reason: SQLITE_INTEGRITY.CORRUPT_NO_BACKUP,
      checkedAt: 50,
    } satisfies PersistenceHealth;
    expect(describePersistenceBanner(noBackup, zh.settings.data.persistence).body)
      .toBe(zh.settings.data.persistence.corruptNoBackup);
  });

  it('translates DB_RESTORE_FAILED with its own copy', () => {
    const restoreFailed = {
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      message: 'DB_RESTORE_FAILED',
      reason: SQLITE_INTEGRITY.RESTORE_FAILED,
      checkedAt: 60,
    } satisfies PersistenceHealth;
    expect(describePersistenceBanner(restoreFailed, zh.settings.data.persistence).body)
      .toBe(zh.settings.data.persistence.restoreFailed);
  });

  it('keeps a clear fallback warning when health text is missing', () => {
    expect(getPersistenceWarningText(unavailable)).toBe('历史持久化不可用，当前只会话内有效。');
    expect(getPersistenceWarningText(null)).toBe('历史持久化不可用，当前只会话内有效。');
  });

  it('returns build info only when the health payload matches the contract', async () => {
    const build = {
      appName: 'Agent Neo Dev',
      branch: 'feat/dev-build-info',
      commit: '1234567890123456789012345678901234567890',
      commitShort: '1234567',
      dirty: false,
      worktree: '/tmp/dev-build-info',
      installedFrom: '/tmp/dev-build-info',
      builtAt: '2026-07-27T12:34:56.000Z',
    } satisfies BuildInfo;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ build }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        build: { ...build, dirty: 'yes' },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWebBuildInfo()).resolves.toEqual(build);
    await expect(fetchWebBuildInfo()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8180/api/health', {
      cache: 'no-store',
    });
  });
});

// 2026-07-27 监工复核补：renderer 走热更新会比 host 新，旧 host 的 /api/health
// 不带 installedFrom。此时整份 build-info 不能被判无效——否则 About 面板恰好在
// 「这包到底是谁装的」最需要排查时空白。
describe('build-info 对旧 host 的容忍', () => {
  it('缺 installedFrom 时仍解析出 build-info', async () => {
    const legacy = {
      appName: 'Agent Neo Dev',
      branch: 'feat/dev-build-info',
      commit: 'a'.repeat(40),
      commitShort: 'aaaaaaa',
      dirty: false,
      worktree: '/tmp/dev-build-info',
      builtAt: '2026-07-27T00:00:00.000Z',
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ build: legacy }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    try {
      const info = await fetchWebBuildInfo();
      expect(info).not.toBeNull();
      expect(info?.branch).toBe('feat/dev-build-info');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
