import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keytarMock = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const entryKey = (service: string, account: string) => `${service}\u0000${account}`;
  return {
    entries,
    setPassword: vi.fn(async (service: string, account: string, password: string) => {
      entries.set(entryKey(service, account), password);
    }),
    getPassword: vi.fn(async (service: string, account: string) => (
      entries.get(entryKey(service, account)) ?? null
    )),
    deletePassword: vi.fn(async (service: string, account: string) => (
      entries.delete(entryKey(service, account))
    )),
  };
});

vi.mock('../../../../src/host/services/core/keytarAdapter', () => ({
  loadKeytar: () => keytarMock,
}));
vi.mock('../../../../src/host/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  app: null,
}));

describe('SecureStorage Keychain session account', () => {
  let dataDir: string;
  const originalBundleId = process.env.CODE_AGENT_BUNDLE_ID;
  const originalCliMode = process.env.CODE_AGENT_CLI_MODE;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    keytarMock.entries.clear();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-storage-keychain-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    delete process.env.CODE_AGENT_CLI_MODE;
  });

  afterEach(() => {
    if (originalBundleId === undefined) delete process.env.CODE_AGENT_BUNDLE_ID;
    else process.env.CODE_AGENT_BUNDLE_ID = originalBundleId;
    if (originalCliMode === undefined) delete process.env.CODE_AGENT_CLI_MODE;
    else process.env.CODE_AGENT_CLI_MODE = originalCliMode;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps two dev bundle ids in independent Keychain accounts', async () => {
    const { getSecureStorage } = await import('../../../../src/host/services/core/secureStorage');
    const storage = getSecureStorage();

    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent.dev';
    await storage.saveSessionToKeychain('slot-1-session');
    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent.dev2';
    await storage.saveSessionToKeychain('slot-2-session');

    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent.dev';
    await expect(storage.getSessionFromKeychain()).resolves.toBe('slot-1-session');
    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent.dev2';
    await expect(storage.getSessionFromKeychain()).resolves.toBe('slot-2-session');

    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent.dev';
    await storage.clearSessionFromKeychain();
    await expect(storage.getSessionFromKeychain()).resolves.toBeNull();
    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent.dev2';
    await expect(storage.getSessionFromKeychain()).resolves.toBe('slot-2-session');

    expect(keytarMock.setPassword).toHaveBeenNthCalledWith(
      1,
      'code-agent',
      'supabase-session:com.linchen.code-agent.dev',
      'slot-1-session',
    );
    expect(keytarMock.setPassword).toHaveBeenNthCalledWith(
      2,
      'code-agent',
      'supabase-session:com.linchen.code-agent.dev2',
      'slot-2-session',
    );
  });

  it('keeps production on the legacy account name for zero-loss upgrades', async () => {
    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent';
    const { getSecureStorage } = await import('../../../../src/host/services/core/secureStorage');
    const storage = getSecureStorage();

    await storage.saveSessionToKeychain('production-session');
    await expect(storage.getSessionFromKeychain()).resolves.toBe('production-session');

    expect(keytarMock.setPassword).toHaveBeenCalledWith(
      'code-agent',
      'supabase-session',
      'production-session',
    );
  });
});
