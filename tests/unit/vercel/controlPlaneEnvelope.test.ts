import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import {
  buildControlPlaneContentHash as buildClientContentHash,
  verifyControlPlaneEnvelope,
} from '../../../src/host/services/cloud/controlPlaneTrust';
import {
  buildControlPlaneContentHash,
  createControlPlaneEnvelope,
  createControlPlaneEnvelopeFromEnv,
  sendControlPlaneEnvelope,
  type ControlPlaneResponseLike,
} from '../../../vercel-api/lib/controlPlaneEnvelope';

function createKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function makeResponse(): ControlPlaneResponseLike & {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
} {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      this.ended = true;
    },
    end() {
      this.ended = true;
    },
  };
}

describe('vercel control-plane envelope', () => {
  it('uses the same canonical content hash as the client verifier', () => {
    const payload = {
      z: 1,
      nested: {
        b: true,
        a: ['x', { y: 'z' }],
      },
    };

    expect(buildControlPlaneContentHash(payload)).toBe(buildClientContentHash(payload));
  });

  it('signs an envelope that the client trust gate accepts', () => {
    const keys = createKeyPair();
    const payload = {
      version: 'signed-config-test',
      prompts: {},
      skills: [],
      toolMeta: {},
      featureFlags: {
        enableCloudAgent: false,
        enableMemory: true,
        enableComputerUse: false,
        maxIterations: 10,
        maxMessageLength: 10000,
        enableExperimentalTools: false,
      },
      uiStrings: { zh: {}, en: {} },
      rules: {},
      mcpServers: [],
    };

    const envelope = createControlPlaneEnvelope({
      kind: 'cloud_config',
      payload,
      keyId: 'unit-test-key',
      privateKey: keys.privateKeyPem,
      issuedAt: '2026-05-17T00:00:00.000Z',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });

    const result = verifyControlPlaneEnvelope<typeof payload>(envelope, {
      kind: 'cloud_config',
      publicKeys: {
        'unit-test-key': keys.publicKeyPem,
      },
      requireSignature: true,
      now: Date.parse('2026-05-17T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      trusted: true,
      payload,
      keyId: 'unit-test-key',
      expiresAt: '2099-12-31T23:59:59.000Z',
      diagnostics: [],
    });
  });

  it('loads base64 encoded private keys from env and returns 304 on matching ETag', () => {
    const keys = createKeyPair();
    const env: NodeJS.ProcessEnv = {
      CONTROL_PLANE_PRIVATE_KEY: Buffer.from(keys.privateKeyPem, 'utf8').toString('base64'),
      CONTROL_PLANE_KEY_ID: 'env-key',
      CONTROL_PLANE_TTL_SECONDS: '3600',
    };
    const payload = { version: 'prompts-test', prompts: { fullSystemPrompt: 'safe' } };
    const envelope = createControlPlaneEnvelopeFromEnv('prompt_registry', payload, env);
    const firstResponse = makeResponse();
    const previousPrivateKey = process.env.CONTROL_PLANE_PRIVATE_KEY;
    const previousKeyId = process.env.CONTROL_PLANE_KEY_ID;
    const previousTtl = process.env.CONTROL_PLANE_TTL_SECONDS;

    try {
      process.env.CONTROL_PLANE_PRIVATE_KEY = env.CONTROL_PLANE_PRIVATE_KEY;
      process.env.CONTROL_PLANE_KEY_ID = env.CONTROL_PLANE_KEY_ID;
      process.env.CONTROL_PLANE_TTL_SECONDS = env.CONTROL_PLANE_TTL_SECONDS;
      sendControlPlaneEnvelope(
        {
          method: 'GET',
          headers: {
            'if-none-match': `"${envelope.contentHash}"`,
          },
        },
        firstResponse,
        'prompt_registry',
        () => payload,
      );
    } finally {
      if (previousPrivateKey === undefined) {
        delete process.env.CONTROL_PLANE_PRIVATE_KEY;
      } else {
        process.env.CONTROL_PLANE_PRIVATE_KEY = previousPrivateKey;
      }
      if (previousKeyId === undefined) {
        delete process.env.CONTROL_PLANE_KEY_ID;
      } else {
        process.env.CONTROL_PLANE_KEY_ID = previousKeyId;
      }
      if (previousTtl === undefined) {
        delete process.env.CONTROL_PLANE_TTL_SECONDS;
      } else {
        process.env.CONTROL_PLANE_TTL_SECONDS = previousTtl;
      }
    }

    expect(firstResponse.statusCode).toBe(304);
    expect(firstResponse.body).toBeUndefined();
  });

  it('allows callers to override env TTL for static signed artifacts', () => {
    const keys = createKeyPair();
    const env: NodeJS.ProcessEnv = {
      CONTROL_PLANE_PRIVATE_KEY: keys.privateKeyPem,
      CONTROL_PLANE_KEY_ID: 'env-key',
      CONTROL_PLANE_TTL_SECONDS: '3600',
    };

    const envelope = createControlPlaneEnvelopeFromEnv(
      'renderer_bundle',
      { version: '0.16.93', minShellVersion: '0.16.93', rollbackToBuiltin: true },
      env,
      {
        now: new Date('2026-06-06T00:00:00.000Z'),
        ttlSeconds: 365 * 24 * 60 * 60,
      },
    );

    expect(envelope.issuedAt).toBe('2026-06-06T00:00:00.000Z');
    expect(envelope.expiresAt).toBe('2027-06-06T00:00:00.000Z');
  });

  it('fails closed when signing configuration is missing', () => {
    const response = makeResponse();
    const previousPrivateKey = process.env.CONTROL_PLANE_PRIVATE_KEY;
    const previousCompatPrivateKey = process.env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY;
    const previousKeyId = process.env.CONTROL_PLANE_KEY_ID;
    const previousCompatKeyId = process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;

    try {
      delete process.env.CONTROL_PLANE_PRIVATE_KEY;
      delete process.env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY;
      delete process.env.CONTROL_PLANE_KEY_ID;
      delete process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
      sendControlPlaneEnvelope(
        { method: 'GET', headers: {} },
        response,
        'cloud_config',
        () => ({ version: 'missing-key', prompts: {} }),
      );
    } finally {
      if (previousPrivateKey === undefined) {
        delete process.env.CONTROL_PLANE_PRIVATE_KEY;
      } else {
        process.env.CONTROL_PLANE_PRIVATE_KEY = previousPrivateKey;
      }
      if (previousCompatPrivateKey === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY = previousCompatPrivateKey;
      }
      if (previousKeyId === undefined) {
        delete process.env.CONTROL_PLANE_KEY_ID;
      } else {
        process.env.CONTROL_PLANE_KEY_ID = previousKeyId;
      }
      if (previousCompatKeyId === undefined) {
        delete process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
      } else {
        process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID = previousCompatKeyId;
      }
    }

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      error: 'control_plane_unconfigured',
    });
  });
});
