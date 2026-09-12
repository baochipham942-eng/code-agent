import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('loadLanIdentity', () => {
  afterEach(() => {
    keytar.getPassword.mockReset();
    keytar.setPassword.mockReset();
  });

  it('promotes an existing companion-identity.json into empty keytar instead of minting a second key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lan-identity-'));
    const identity = createIdentity();
    const encoded = JSON.stringify({ publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey) });
    await writeFile(join(dir, 'companion-identity.json'), encoded, { mode: 0o600 });
    keytar.getPassword.mockResolvedValueOnce(null).mockResolvedValueOnce(encoded);
    keytar.setPassword.mockResolvedValue(undefined);

    const loaded = await loadLanIdentity(dir);

    expect(toHex(loaded.publicKey)).toBe(toHex(identity.publicKey));
    expect(keytar.setPassword).toHaveBeenCalledOnce();
    expect(keytar.setPassword.mock.calls[0][2]).toBe(encoded);
    expect(await readFile(join(dir, 'companion-identity.json'), 'utf8')).toBe(encoded);
  });
});
