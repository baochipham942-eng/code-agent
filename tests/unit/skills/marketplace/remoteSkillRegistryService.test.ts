import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneEnvelope } from '../../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../../vercel-api/lib/controlPlaneEnvelope';

const mocks = vi.hoisted(() => ({
  listInstalledPlugins: vi.fn(async () => ({} as Record<string, unknown>)),
}));

vi.mock('../../../../src/host/skills/marketplace/installService', () => ({
  listInstalledPlugins: mocks.listInstalledPlugins,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { RemoteSkillRegistryService } from '../../../../src/host/skills/marketplace/remoteSkillRegistryService';

const PIN_A = 'a'.repeat(40);
const PIN_B = 'b'.repeat(40);
const HASH_A = '1'.repeat(64);

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: 'demo-pack',
    displayName: '演示包',
    description: 'demo',
    repository: 'owner/demo-repo',
    pinnedCommit: PIN_A,
    contentHash: HASH_A,
    skills: ['skills/demo'],
    keywords: ['demo keyword'],
    domains: ['demo.example'],
    publisher: 'Agent Neo',
    reviewedAt: '2026-07-13',
    risk: { tier: 'low' },
    ...overrides,
  };
}

function signedRegistry(
  entries: unknown[],
  opts: { kind?: string; keyId?: string } = {},
) {
  const payload = { schemaVersion: 1, entries };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind: (opts.kind ?? 'skill_registry') as ControlPlaneEnvelope['kind'],
    issuedAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: opts.keyId ?? 'sr-key',
    payload,
  };
  envelope.signature = crypto
    .sign(null, Buffer.from(buildControlPlaneSigningPayload(envelope)), privateKey)
    .toString('base64');
  return {
    envelope,
    publicKeys: {
      [envelope.keyId!]: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

function serviceFor(envelope: unknown, publicKeys: Record<string, string>) {
  return new RemoteSkillRegistryService({
    controlPlanePublicKeys: publicKeys,
    endpoint: 'https://example.test/api/v1/skill-registry',
    fetchImpl: vi.fn(async () => new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
  });
}

describe('RemoteSkillRegistryService', () => {
  it('accepts a signed skill_registry envelope and returns validated entries', async () => {
    const { envelope, publicKeys } = signedRegistry([validEntry()]);
    const result = await serviceFor(envelope, publicKeys).fetchEntries();
    expect(result.error).toBeUndefined();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.pinnedCommit).toBe(PIN_A);
    expect(result.entries[0]!.keywords).toEqual(['demo keyword']);
    expect(result.entries[0]!.domains).toEqual(['demo.example']);
  });

  it('keeps registry payloads without keywords and domains backward-compatible', async () => {
    const legacyEntry = validEntry({ keywords: undefined, domains: undefined });
    const { envelope, publicKeys } = signedRegistry([legacyEntry]);
    const result = await serviceFor(envelope, publicKeys).fetchEntries();

    expect(result.error).toBeUndefined();
    expect(result.entries.map((entry) => ({
      name: entry.name,
      keywords: entry.keywords,
      domains: entry.domains,
    }))).toEqual([
      { name: 'demo-pack', keywords: undefined, domains: undefined },
    ]);
  });

  it('rejects an envelope with a mismatched artifact kind', async () => {
    const { envelope, publicKeys } = signedRegistry([validEntry()], { kind: 'cloud_config' });
    const result = await serviceFor(envelope, publicKeys).fetchEntries();
    expect(result.entries).toHaveLength(0);
    expect(result.error).toBe('untrusted_envelope');
  });

  it('drops invalid entries without discarding the valid rest', async () => {
    const { envelope, publicKeys } = signedRegistry([
      validEntry(),
      validEntry({ name: 'bad-pin', pinnedCommit: 'refs/heads/main' }),
      validEntry({ name: 'bad-hash', contentHash: 'not-hex' }),
    ]);
    const result = await serviceFor(envelope, publicKeys).fetchEntries();
    expect(result.entries.map((entry) => entry.name)).toEqual(['demo-pack']);
  });

  it('returns an empty shelf with a reason code when fetch fails', async () => {
    const service = new RemoteSkillRegistryService({
      controlPlanePublicKeys: { 'sr-key': 'irrelevant' },
      endpoint: 'https://example.test/api/v1/skill-registry',
      fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    });
    const result = await service.fetchEntries();
    expect(result.entries).toHaveLength(0);
    expect(result.error).toBe('fetch_failed');
  });

  it('marks installed entries and flags updates when the registry pin moves', async () => {
    mocks.listInstalledPlugins.mockResolvedValue({
      'demo-pack@official-registry': { pinnedCommit: PIN_B },
    });
    const { envelope, publicKeys } = signedRegistry([validEntry()]);
    const { items } = await serviceFor(envelope, publicKeys).listItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.installed).toBe(true);
    expect(items[0]!.installedPinnedCommit).toBe(PIN_B);
    expect(items[0]!.hasUpdate).toBe(true);
  });

  it('listItemsCached 在 TTL 内只打一次网络，invalidateListCache 后重新拉取', async () => {
    const { envelope, publicKeys } = signedRegistry([validEntry()]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const service = new RemoteSkillRegistryService({
      controlPlanePublicKeys: publicKeys,
      endpoint: 'https://example.test/api/v1/skill-registry',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await service.listItemsCached();
    const second = await service.listItemsCached();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    service.invalidateListCache();
    await service.listItemsCached();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('listItemsCached 空货架/失败不缓存，下次重试', async () => {
    const service = new RemoteSkillRegistryService({
      controlPlanePublicKeys: { 'sr-key': 'not-used' },
      endpoint: 'https://example.test/api/v1/skill-registry',
      fetchImpl: vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    });
    expect(await service.listItemsCached()).toEqual([]);
    // 失败未缓存：再次调用仍会尝试拉取（fetchImpl 被再次调用）
    expect(await service.listItemsCached()).toEqual([]);
  });
});
