import { createHash } from 'node:crypto';
import type { KeyPair } from 'noise-handshake';
import { loadKeytar } from '../services/core/keytarAdapter';
import { createIdentity } from '../../shared/companion/noiseChannel';
import { fromHex, toHex } from '../../shared/companion/lanProtocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Installation/data-slot scoped; unavailable keychain means pairing stays unavailable. */
export async function loadLanIdentity(dataDirectory: string): Promise<KeyPair> {
  const keytar = loadKeytar();
  if (!keytar) {
    // Browser/web development environments may not have keytar available.
    // Persist the identity in the per-slot data directory so local pairing
    // remains usable; packaged desktop builds still use the OS keychain.
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
