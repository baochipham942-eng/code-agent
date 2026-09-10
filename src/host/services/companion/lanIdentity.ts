import { createHash } from 'node:crypto';
import type { KeyPair } from 'noise-handshake';
import { loadKeytar } from '../core/keytarAdapter';
import { createIdentity } from '../../../shared/companion/noiseChannel';
import { fromHex, toHex } from '../../../shared/companion/lanProtocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The host's long-term Noise static key, scoped per installation/data slot.
 *
 * Two storage tiers, and the weaker one is deliberate:
 *
 * 1. Packaged desktop builds have keytar → OS keychain. A write that cannot be read
 *    back throws, so pairing fails rather than running on a key that did not persist.
 * 2. Hosts without keytar (web server, CLI, browser dev) fall back to a **plaintext**
 *    `companion-identity.json` in the data directory, mode 0600. This is not encrypted
 *    and is not equivalent to tier 1.
 *
 * ponytail: why plaintext is accepted here. Reading that file requires read access to the
 * data directory, which already holds `code-agent.db` (session content and device
 * credentials) and `.env` (provider API keys) — so the identity is not the weakest thing
 * an attacker with that access already has. What it does NOT protect against: someone who
 * can read the file can impersonate this host to an already-paired phone on the LAN,
 * because a resume handshake only proves possession of this key. Initial pairing is
 * unaffected: it needs the one-shot PSK from the QR as well.
 * Upgrade path: give the web/CLI hosts a real secret store (or require pairing to be
 * initiated from the packaged desktop app) and delete this branch.
 */
export async function loadLanIdentity(dataDirectory: string): Promise<KeyPair> {
  const keytar = loadKeytar();
  if (!keytar) {
    const file = join(dataDirectory, 'companion-identity.json');
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as { publicKey: string; secretKey: string };
      return { publicKey: fromHex(value.publicKey, 32), secretKey: fromHex(value.secretKey, 32) };
    } catch { /* create below */ }
    const identity = createIdentity();
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(file, JSON.stringify({ publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) }), { mode: 0o600 });
    return identity;
  }
  const service = 'dev.neo.companion.host.v1';
  const account = createHash('sha256').update(dataDirectory).digest('hex');
  const stored = await keytar.getPassword(service, account);
  if (stored) {
    const value = JSON.parse(stored) as { publicKey: string; secretKey: string };
    return { publicKey: fromHex(value.publicKey, 32), secretKey: fromHex(value.secretKey, 32) };
  }
  const identity = createIdentity();
  const encoded = JSON.stringify({ publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
  try {
    await keytar.setPassword(service, account, encoded);
    if (await keytar.getPassword(service, account) !== encoded) throw new Error('COMPANION_SECURE_STORAGE_UNAVAILABLE');
    return identity;
  } catch (error) { identity.secretKey.fill(0); throw error; }
}
