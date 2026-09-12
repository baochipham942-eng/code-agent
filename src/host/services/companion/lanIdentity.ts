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
const IDENTITY_FILE = 'companion-identity.json';
const KEYTAR_SERVICE = 'dev.neo.companion.host.v1';

function decode(encoded: string): KeyPair {
  const value = JSON.parse(encoded) as { publicKey: string; secretKey: string };
  return { publicKey: fromHex(value.publicKey, 32), secretKey: fromHex(value.secretKey, 32) };
}

function encode(identity: KeyPair): string {
  return JSON.stringify({ publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
}

async function readFileIdentity(dataDirectory: string): Promise<{ identity: KeyPair; encoded: string } | null> {
  try {
    const identity = decode(await readFile(join(dataDirectory, IDENTITY_FILE), 'utf8'));
    return { identity, encoded: encode(identity) };
  } catch {
    return null;
  }
}

async function writeFileIdentity(dataDirectory: string, encoded: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, IDENTITY_FILE), encoded, { mode: 0o600 });
}

export async function loadLanIdentity(dataDirectory: string): Promise<KeyPair> {
  const keytar = loadKeytar();
  if (!keytar) {
    const existing = await readFileIdentity(dataDirectory);
    if (existing) return existing.identity;
    const identity = createIdentity();
    await writeFileIdentity(dataDirectory, encode(identity));
    return identity;
  }
  const account = createHash('sha256').update(dataDirectory).digest('hex');
  const stored = await keytar.getPassword(KEYTAR_SERVICE, account);
  if (stored) return decode(stored);
  // A host that previously ran without keytar (web/CLI) already paired phones against
  // companion-identity.json. Minting a fresh keychain key here makes resume 403
  // "电脑未接受此次配对" for every already-paired device. Promote the file identity.
  const existing = await readFileIdentity(dataDirectory);
  const identity = existing?.identity ?? createIdentity();
  const encoded = existing?.encoded ?? encode(identity);
  try {
    await keytar.setPassword(KEYTAR_SERVICE, account, encoded);
    if (await keytar.getPassword(KEYTAR_SERVICE, account) !== encoded) throw new Error('COMPANION_SECURE_STORAGE_UNAVAILABLE');
    if (!existing) await writeFileIdentity(dataDirectory, encoded);
    return identity;
  } catch (error) { identity.secretKey.fill(0); throw error; }
}
