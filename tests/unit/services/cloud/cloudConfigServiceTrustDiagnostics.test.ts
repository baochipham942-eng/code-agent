import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import type { ControlPlaneEnvelope } from '../../../../src/shared/contract/controlPlane';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: vi.fn(() => logger),
}));

import { CloudConfigService } from '../../../../src/main/services/cloud/cloudConfigService';
import {
  getBuiltinConfig,
  type CloudConfig,
} from '../../../../src/main/services/cloud/builtinConfig';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
  CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT,
} from '../../../../src/main/services/cloud/controlPlaneTrust';

function mockJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: () => null,
    },
    json: async () => body,
  };
}

function buildSignedCloudConfig(config: CloudConfig, keyId = 'remote-key') {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<CloudConfig> = {
    schemaVersion: 1,
    kind: 'cloud_config',
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(config),
    keyId,
    payload: config,
  };
  envelope.signature = crypto.sign(
    null,
    Buffer.from(buildControlPlaneSigningPayload(envelope)),
    privateKey,
  ).toString('base64');
  return envelope;
}

describe('CloudConfigService trust diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODE_AGENT_ALLOW_UNSIGNED_CLOUD_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports readable unknown_key_id remediation while failing closed', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockJsonResponse(buildSignedCloudConfig({
      ...getBuiltinConfig(),
      version: 'signed-remote',
    })));
    vi.stubGlobal('fetch', fetchMock);

    const service = new CloudConfigService({
      controlPlanePublicKeys: {
        'alpha-key': 'alpha-public-key',
        'beta-key': 'beta-public-key',
      },
    });

    await service.initialize();

    const info = service.getInfo();
    const unknownKeyDiagnostic = info.trust.diagnostics.find((entry) => entry.code === 'unknown_key_id') as
      | undefined
      | (typeof info.trust.diagnostics[number] & {
        keyId?: string;
        knownKeyCount?: number;
        knownKeyIds?: string[];
        remediationHint?: string;
      });
    const rejectedLogCall = logger.warn.mock.calls.find(([message]) => message === 'Rejected untrusted cloud config');
    const rejectedLogPayload = rejectedLogCall?.[1] as
      | undefined
      | {
        diagnostics?: string;
        trustDiagnostics?: unknown[];
      };

    expect(info.fromCloud).toBe(false);
    expect(info.trust.trusted).toBe(false);
    expect(info.lastError).toContain('unknown_key_id:');
    expect(info.lastError).toContain('keyId=remote-key');
    expect(info.lastError).toContain('knownKeyCount=2');
    expect(info.lastError).toContain('knownKeyIds=[alpha-key, beta-key]');
    expect(info.lastError).toContain(`remediationHint=${CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT}`);
    expect(unknownKeyDiagnostic).toMatchObject({
      keyId: 'remote-key',
      knownKeyCount: 2,
      knownKeyIds: ['alpha-key', 'beta-key'],
      remediationHint: CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT,
    });
    expect(rejectedLogPayload?.diagnostics).toContain('unknown_key_id:');
    expect(rejectedLogPayload?.diagnostics).toContain('keyId=remote-key');
    expect(rejectedLogPayload?.trustDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown_key_id',
        keyId: 'remote-key',
        remediationHint: CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT,
      }),
    ]));
    expect(service.getConfig().version).toBe(getBuiltinConfig().version);
  });
});
