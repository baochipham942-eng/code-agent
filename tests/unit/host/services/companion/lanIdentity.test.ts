import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createIdentity } from '../../../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../../../src/shared/companion/lanProtocol';

const keytar = {
  getPassword: vi.fn(),
  setPassword: vi.fn(),
};

vi.mock('../../../../../src/host/services/core/keytarAdapter', () => ({
  loadKeytar: () => keytar,
}));

const { loadLanIdentity } = await import('../../../../../src/host/services/companion/lanIdentity');

const IDENTITY_FILE = 'companion-identity.json';

function encodeIdentity(identity: { publicKey: Uint8Array; secretKey: Uint8Array }): string {
  return JSON.stringify({ publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
}

/** Mirrors `src/web/app.ts` POST /api/companion/manage: loadIdentity throw → HTTP 500. */
async function companionManageInvite(dataDirectory: string): Promise<{ status: number; hostKey?: string; code?: string }> {
  try {
    const identity = await loadLanIdentity(dataDirectory);
    return { status: 200, hostKey: toHex(identity.publicKey) };
  } catch (error) {
    return { status: 500, code: 'COMPANION_MANAGE_FAILED', hostKey: error instanceof Error ? error.message : String(error) };
  }
}

describe('loadLanIdentity', () => {
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    keytar.getPassword.mockReset();
    keytar.setPassword.mockReset();
    warn.mockRestore();
  });

  it('promotes an existing companion-identity.json into empty keytar instead of minting a second key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-identity-'));
    const identity = createIdentity();
    const encoded = encodeIdentity(identity);
    await writeFile(join(dir, IDENTITY_FILE), encoded, { mode: 0o600 });
    keytar.getPassword.mockResolvedValueOnce(null).mockResolvedValueOnce(encoded);
    keytar.setPassword.mockResolvedValue(undefined);

    const loaded = await loadLanIdentity(dir);

    expect(toHex(loaded.publicKey)).toBe(toHex(identity.publicKey));
    expect(keytar.setPassword).toHaveBeenCalledOnce();
    expect(keytar.setPassword.mock.calls[0][2]).toBe(encoded);
    expect(await readFile(join(dir, IDENTITY_FILE), 'utf8')).toBe(encoded);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to companion-identity.json when setPassword throws so invite does not 500', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-identity-'));
    keytar.getPassword.mockResolvedValue(null);
    keytar.setPassword.mockRejectedValue(new Error('An unknown error occurred.'));

    const first = await companionManageInvite(dir);
    expect(first.status).toBe(200);
    expect(first.hostKey).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = await readFile(join(dir, IDENTITY_FILE), 'utf8');
    const parsed = JSON.parse(onDisk) as { publicKey: string; secretKey: string };
    expect(parsed.publicKey).toBe(first.hostKey);
    expect((await stat(join(dir, IDENTITY_FILE))).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain('companion-identity.json');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(parsed.secretKey);

    const second = await companionManageInvite(dir);
    expect(second.status).toBe(200);
    expect(second.hostKey).toBe(first.hostKey);
    expect(await readFile(join(dir, IDENTITY_FILE), 'utf8')).toBe(onDisk);
  });

  it('falls back to the existing file identity when setPassword throws instead of minting a second key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-identity-'));
    const identity = createIdentity();
    const encoded = encodeIdentity(identity);
    await writeFile(join(dir, IDENTITY_FILE), encoded, { mode: 0o600 });
    keytar.getPassword.mockResolvedValue(null);
    keytar.setPassword.mockRejectedValue(new Error('An unknown error occurred.'));

    const loaded = await loadLanIdentity(dir);

    expect(toHex(loaded.publicKey)).toBe(toHex(identity.publicKey));
    expect(toHex(loaded.secretKey)).toBe(toHex(identity.secretKey));
    expect(await readFile(join(dir, IDENTITY_FILE), 'utf8')).toBe(encoded);
    expect(keytar.setPassword).toHaveBeenCalledOnce();
  });

  it('falls back to the file when keychain read-back does not match the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-identity-'));
    keytar.getPassword.mockResolvedValueOnce(null).mockResolvedValueOnce('not-what-was-written');
    keytar.setPassword.mockResolvedValue(undefined);

    const loaded = await loadLanIdentity(dir);
    const onDisk = JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8')) as { publicKey: string; secretKey: string };

    expect(onDisk.publicKey).toBe(toHex(loaded.publicKey));
    expect(warn.mock.calls.some(call => String(call[0]).includes('companion-identity.json'))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(onDisk.secretKey);
  });

  it('keeps the keychain path when setPassword persists and reads back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-identity-'));
    let stored: string | null = null;
    keytar.getPassword.mockImplementation(async () => stored);
    keytar.setPassword.mockImplementation(async (_service: string, _account: string, password: string) => {
      stored = password;
    });

    const first = await loadLanIdentity(dir);
    const second = await loadLanIdentity(dir);

    expect(toHex(second.publicKey)).toBe(toHex(first.publicKey));
    expect(keytar.setPassword).toHaveBeenCalledOnce();
    expect(stored).toBe(encodeIdentity(first));
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not mint or swap identity when getPassword throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-identity-'));
    const identity = createIdentity();
    const encoded = encodeIdentity(identity);
    await writeFile(join(dir, IDENTITY_FILE), encoded, { mode: 0o600 });
    keytar.getPassword.mockRejectedValue(new Error('An unknown error occurred.'));

    await expect(loadLanIdentity(dir)).rejects.toThrow('An unknown error occurred.');
    expect(await readFile(join(dir, IDENTITY_FILE), 'utf8')).toBe(encoded);
    expect(keytar.setPassword).not.toHaveBeenCalled();

    const empty = await mkdtemp(join(tmpdir(), 'lan-identity-empty-'));
    await expect(loadLanIdentity(empty)).rejects.toThrow('An unknown error occurred.');
    await expect(readFile(join(empty, IDENTITY_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
