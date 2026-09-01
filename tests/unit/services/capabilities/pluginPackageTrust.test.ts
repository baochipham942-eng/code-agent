import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashPluginPackage,
  PLUGIN_PACKAGE_SIGNATURE_FILE,
  writePluginApprovalReceipt,
} from '../../../../src/host/plugins/pluginApprovalReceipt';
import { verifyInstalledPluginTrust } from '../../../../src/host/plugins/pluginPackageTrust';
import { readPluginPackageRevocations } from '../../../../src/host/plugins/pluginPackageRevocationStore';
import type { PluginManifest } from '../../../../src/host/plugins/types';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../../src/host/services/cloud/controlPlaneTrust';
import { RemoteCapabilityRegistryService } from '../../../../src/host/services/capabilities/remoteCapabilityRegistryService';
import type { ControlPlaneEnvelope } from '../../../../src/shared/contract/controlPlane';

const KEY_ID = 'author-key';
let rootDir: string;
let publicKey: string;
let privateKey: KeyObject;

function manifest(): PluginManifest {
  return {
    id: 'signed-plugin',
    name: 'Signed plugin',
    version: '1.0.0',
    description: 'trust fixture',
    main: 'index.js',
    permissions: [],
    surfaces: ['tools'],
  };
}

async function writeSignedPackage(): Promise<PluginManifest> {
  const value = manifest();
  await fs.writeFile(path.join(rootDir, 'plugin.json'), JSON.stringify(value), 'utf8');
  await fs.writeFile(path.join(rootDir, 'index.js'), 'module.exports = { async activate() {} };', 'utf8');
  const packageHash = await hashPluginPackage(rootDir);
  const payload = { schemaVersion: 1 as const, pluginId: value.id, packageHash };
  const envelope: ControlPlaneEnvelope<typeof payload> = {
    schemaVersion: 1,
    kind: 'plugin_package',
    expiresAt: '2099-01-01T00:00:00.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: KEY_ID,
    payload,
  };
  envelope.signature = sign(
    null,
    Buffer.from(buildControlPlaneSigningPayload(envelope)),
    privateKey,
  ).toString('base64');
  await fs.writeFile(path.join(rootDir, PLUGIN_PACKAGE_SIGNATURE_FILE), JSON.stringify(envelope), 'utf8');
  return value;
}

async function writeReceipt(value: PluginManifest, packageHash: string): Promise<void> {
  await writePluginApprovalReceipt(rootDir, {
    pluginId: value.id,
    packageHash,
    permissions: [],
    sandboxValidatedAt: 1,
    approvedAt: 2,
  });
}

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-package-trust-'));
  const keys = generateKeyPairSync('ed25519');
  privateKey = keys.privateKey;
  publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('installed plugin trust doors', () => {
  it('rejects the signature door while the approval hash door passes', async () => {
    const value = await writeSignedPackage();
    await writeReceipt(value, await hashPluginPackage(rootDir));
    const signaturePath = path.join(rootDir, PLUGIN_PACKAGE_SIGNATURE_FILE);
    const envelope = JSON.parse(await fs.readFile(signaturePath, 'utf8')) as Record<string, unknown>;
    envelope.signature = Buffer.alloc(64, 3).toString('base64');
    await fs.writeFile(signaturePath, JSON.stringify(envelope), 'utf8');

    await expect(verifyInstalledPluginTrust(rootDir, value, {
      publicKeys: { [KEY_ID]: publicKey },
    })).rejects.toThrow('插件签名无效，无法确认发布来源');
  });

  it('rejects the approval hash door while the valid signature door passes', async () => {
    const value = await writeSignedPackage();
    await writeReceipt(value, '0'.repeat(64));

    await expect(verifyInstalledPluginTrust(rootDir, value, {
      publicKeys: { [KEY_ID]: publicKey },
      revokedIds: new Set(),
    })).rejects.toThrow('插件内容哈希校验未通过');
  });

  it('runs the signature revocation door even when the approval hash door already fails', async () => {
    const value = await writeSignedPackage();
    await writeReceipt(value, '0'.repeat(64));

    await expect(verifyInstalledPluginTrust(rootDir, value, {
      publicKeys: { [KEY_ID]: publicKey },
      revokedIds: new Set([`plugin-key:${KEY_ID}`]),
    })).rejects.toThrow(
      /插件内容哈希校验未通过.*这个插件的发布者已被吊销/,
    );
  });

  it('blocks a previously valid installed package after its author key is revoked', async () => {
    const value = await writeSignedPackage();
    await writeReceipt(value, await hashPluginPackage(rootDir));

    await expect(verifyInstalledPluginTrust(rootDir, value, {
      publicKeys: { [KEY_ID]: publicKey },
      revokedIds: new Set(),
    })).resolves.toMatchObject({ sourceTrust: { level: 'signed', keyId: KEY_ID } });
    await expect(verifyInstalledPluginTrust(rootDir, value, {
      publicKeys: { [KEY_ID]: publicKey },
      revokedIds: new Set([`plugin-key:${KEY_ID}`]),
    })).rejects.toThrow('这个插件的发布者已被吊销，插件已停止装载，请联系管理员');
  });
});

describe('signed capability registry revocation channel', () => {
  it('persists plugin and author revocations from the trusted registry envelope', async () => {
    const payload = { items: [], revokedIds: ['plugin:signed-plugin', `plugin-key:${KEY_ID}`] };
    const envelope: ControlPlaneEnvelope<typeof payload> = {
      schemaVersion: 1,
      kind: 'capability_registry',
      expiresAt: '2099-01-01T00:00:00.000Z',
      contentHash: buildControlPlaneContentHash(payload),
      keyId: KEY_ID,
      payload,
    };
    envelope.signature = sign(
      null,
      Buffer.from(buildControlPlaneSigningPayload(envelope)),
      privateKey,
    ).toString('base64');
    const revocationFile = path.join(rootDir, 'revocations.json');
    const service = new RemoteCapabilityRegistryService({
      endpoint: 'https://control.example.test/capabilities',
      controlPlanePublicKeys: { [KEY_ID]: publicKey },
      pluginRevocationFile: revocationFile,
      fetchImpl: async () => new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    await expect(service.readRegistry()).resolves.toMatchObject({ items: [], diagnostics: [] });
    await expect(readPluginPackageRevocations(revocationFile)).resolves.toEqual(
      new Set(['plugin:signed-plugin', `plugin-key:${KEY_ID}`]),
    );
  });
});
