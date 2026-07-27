import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWebBuildInfo,
  getPersistenceWarningText,
  shouldShowPersistenceWarning,
} from '../../../src/renderer/services/persistenceHealth';
import type { BuildInfo, PersistenceHealth } from '../../../src/shared/contract';

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
