import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { SKILL_CATEGORIES } from '../../../../src/shared/constants/skillCatalog';
import type { ControlPlaneEnvelope } from '../../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../../vercel-api/lib/controlPlaneEnvelope';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getRolePackRegistryService } from '../../../../src/host/services/roleAssets/rolePackRegistryService';

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    roleId: 'demo-role',
    displayName: '演示专家',
    agentMd: '---\nname: 演示专家\n---\n\n正文',
    visual: {
      icon: 'UserCircle',
      category: 'research',
      displayName: '演示专家',
      profession: '研究员',
      tags: ['调研'],
      quickPrompts: ['调研这个主题'],
    },
    skills: [{ registryName: 'demo-skill' }],
    packVersion: '1.0.0',
    publisher: 'Agent Neo',
    reviewedAt: '2026-07-22',
    risk: { tier: 'low' },
    ...overrides,
  };
}

function signedRegistry(
  payload: Record<string, unknown>,
  opts: { kind?: string } = {},
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'role-key';
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind: (opts.kind ?? 'role_registry') as ControlPlaneEnvelope['kind'],
    issuedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId,
    payload,
  };
  envelope.signature = crypto
    .sign(null, Buffer.from(buildControlPlaneSigningPayload(envelope)), privateKey)
    .toString('base64');
  return {
    envelope,
    publicKeys: {
      [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

function serviceFor(envelope: unknown, publicKeys: Record<string, string>, appVersion = '0.28.1') {
  const service = getRolePackRegistryService();
  service.invalidateEntriesCache();
  service.setOptions({
    controlPlanePublicKeys: publicKeys,
    endpoint: 'https://example.test/api/v1/role-registry',
    appVersion,
    fetchImpl: vi.fn(async () => new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
  });
  return service;
}

describe('RolePackRegistryService', () => {
  it('签名不过时返回空货架和 untrusted_envelope', async () => {
    const { envelope, publicKeys } = signedRegistry({ schemaVersion: 1, entries: [validEntry()] });
    envelope.signature = 'invalid-signature';

    await expect(serviceFor(envelope, publicKeys).fetchEntries()).resolves.toEqual({
      entries: [],
      error: 'untrusted_envelope',
    });
  });

  it('kind 不匹配时返回空货架', async () => {
    const { envelope, publicKeys } = signedRegistry(
      { schemaVersion: 1, entries: [validEntry()] },
      { kind: 'skill_registry' },
    );
    const result = await serviceFor(envelope, publicKeys).fetchEntries();

    expect(result).toEqual({ entries: [], error: 'untrusted_envelope' });
  });

  it('单条畸形只丢弃该条，其余条目仍可展示', async () => {
    const { envelope, publicKeys } = signedRegistry({
      schemaVersion: 1,
      entries: [validEntry(), validEntry({ roleId: '', packVersion: '' })],
    });
    const result = await serviceFor(envelope, publicKeys).fetchEntries();

    expect(result.entries.map((entry) => entry.roleId)).toEqual(['demo-role']);
    expect(result.error).toBeUndefined();
  });

  it('minAppVersion 高于本机版本时直接丢弃该条', async () => {
    const { envelope, publicKeys } = signedRegistry({
      schemaVersion: 1,
      entries: [validEntry({ minAppVersion: '999.0.0' })],
    });
    const result = await serviceFor(envelope, publicKeys).fetchEntries();

    expect(result).toEqual({ entries: [] });
  });

  it('payload schemaVersion 不对时返回 invalid_payload', async () => {
    const { envelope, publicKeys } = signedRegistry({ schemaVersion: 2, entries: [validEntry()] });

    await expect(serviceFor(envelope, publicKeys).fetchEntries()).resolves.toEqual({
      entries: [],
      error: 'invalid_payload',
    });
  });

  it('接受 SKILL_CATEGORIES 中的每一个分类 id', async () => {
    for (const { id } of SKILL_CATEGORIES) {
      const entry = validEntry({
        visual: {
          icon: 'UserCircle',
          category: id,
          displayName: '演示专家',
          profession: '研究员',
          tags: ['调研'],
          quickPrompts: ['调研这个主题'],
        },
      });
      const { envelope, publicKeys } = signedRegistry({ schemaVersion: 1, entries: [entry] });

      const result = await serviceFor(envelope, publicKeys).fetchEntries();

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].visual.category).toBe(id);
    }
  });
});
