import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import capabilitiesHandler from '../../../vercel-api/api/v1/capabilities';
import controlPlaneHandler from '../../../vercel-api/api/v1/control-plane';
import type { ControlPlaneResponseLike } from '../../../vercel-api/lib/controlPlaneEnvelope';

function createKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
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

function withControlPlaneEnv(fn: () => void): void {
  const previousPrivateKey = process.env.CONTROL_PLANE_PRIVATE_KEY;
  const previousKeyId = process.env.CONTROL_PLANE_KEY_ID;
  const previousPayload = process.env.CONTROL_PLANE_CAPABILITY_REGISTRY_JSON;

  try {
    process.env.CONTROL_PLANE_PRIVATE_KEY = createKeyPair();
    process.env.CONTROL_PLANE_KEY_ID = 'capability-test-key';
    process.env.CONTROL_PLANE_CAPABILITY_REGISTRY_JSON = JSON.stringify({
      version: 'capabilities-test',
      items: [{
        id: 'mcp-template:test',
        kind: 'mcp_template',
        name: 'Test MCP template',
      }],
      revokedIds: ['old-template'],
    });
    fn();
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
    if (previousPayload === undefined) {
      delete process.env.CONTROL_PLANE_CAPABILITY_REGISTRY_JSON;
    } else {
      process.env.CONTROL_PLANE_CAPABILITY_REGISTRY_JSON = previousPayload;
    }
  }
}

describe('vercel control-plane artifacts', () => {
  it('serves capability registry through the unified control-plane route', () => {
    withControlPlaneEnv(() => {
      const response = makeResponse();

      controlPlaneHandler({
        method: 'GET',
        query: { artifact: 'capabilities' },
        headers: {},
      }, response);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        schemaVersion: 1,
        kind: 'capability_registry',
        keyId: 'capability-test-key',
        payload: {
          version: 'capabilities-test',
          revokedIds: ['old-template'],
        },
      });
      expect(response.headers['ETag']).toMatch(/^"sha256:/);
      expect(response.headers['X-Control-Plane-Key-Id']).toBe('capability-test-key');
    });
  });

  it('serves capability registry through the direct v1 capabilities route', () => {
    withControlPlaneEnv(() => {
      const response = makeResponse();

      capabilitiesHandler({ method: 'GET', headers: {} }, response);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'capability_registry',
        payload: {
          version: 'capabilities-test',
        },
      });
    });
  });
});
