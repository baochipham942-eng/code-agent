import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import capabilitiesHandler from '../../../vercel-api/api/v1/capabilities';
import configHandler from '../../../vercel-api/api/v1/config';
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

function withCloudConfigEnv(options: {
  entitlementRequired?: boolean;
  tokenMap?: unknown;
}, fn: () => void): void {
  const keys = [
    'CONTROL_PLANE_PRIVATE_KEY',
    'CONTROL_PLANE_KEY_ID',
    'CONTROL_PLANE_CLOUD_CONFIG_JSON',
    'CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    process.env.CONTROL_PLANE_PRIVATE_KEY = createKeyPair();
    process.env.CONTROL_PLANE_KEY_ID = 'cloud-config-test-key';
    process.env.CONTROL_PLANE_CLOUD_CONFIG_JSON = JSON.stringify({
      version: 'cloud-config-test',
      prompts: {},
      skills: [],
      toolMeta: {},
      featureFlags: {
        enableCloudAgent: true,
      },
      uiStrings: { zh: {}, en: {} },
      rules: {},
      mcpServers: [],
      entitlement: {
        status: 'active',
        plan: 'static-admin',
        capabilities: ['*'],
      },
    });
    if (options.entitlementRequired !== undefined) {
      process.env.CONTROL_PLANE_ENTITLEMENT_REQUIRED = options.entitlementRequired ? 'true' : 'false';
    } else {
      delete process.env.CONTROL_PLANE_ENTITLEMENT_REQUIRED;
    }
    if (options.tokenMap !== undefined) {
      process.env.CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON = JSON.stringify(options.tokenMap);
    } else {
      delete process.env.CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON;
    }
    fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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

  it('fails closed for cloud config entitlement when auth is required and no token is provided', () => {
    withCloudConfigEnv({ entitlementRequired: true }, () => {
      const response = makeResponse();

      controlPlaneHandler({
        method: 'GET',
        query: { artifact: 'cloud_config' },
        headers: {},
      }, response);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'cloud_config',
        payload: {
          entitlement: {
            status: 'revoked',
            plan: 'unauthenticated',
            capabilities: [],
            reason: 'missing_verified_subject',
          },
        },
      });
    });
  });

  it('fails closed for cloud config entitlement when token is invalid and ignores client plan claims', () => {
    withCloudConfigEnv({
      entitlementRequired: true,
      tokenMap: {
        'server-token': {
          subject: { id: 'user_server', email: 'server@example.com' },
          entitlement: {
            status: 'active',
            plan: 'pro',
            capabilities: ['mcp_cloud'],
          },
        },
      },
    }, () => {
      const response = makeResponse();

      controlPlaneHandler({
        method: 'GET',
        query: { artifact: 'cloud_config' },
        headers: { authorization: 'Bearer wrong-token' },
        body: {
          isAdmin: true,
          plan: 'enterprise',
          capabilities: ['*'],
        },
      }, response);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'cloud_config',
        payload: {
          entitlement: {
            status: 'revoked',
            plan: 'unauthenticated',
            capabilities: [],
            reason: 'invalid_verified_subject',
          },
        },
      });
      expect(JSON.stringify(response.body)).not.toContain('enterprise');
    });
  });

  it('serves active cloud config entitlement only for a server-side mapped subject', () => {
    withCloudConfigEnv({
      tokenMap: {
        'server-token': {
          subject: { id: 'user_server', email: 'server@example.com' },
          entitlement: {
            status: 'active',
            plan: 'pro',
            capabilities: ['mcp_cloud'],
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        },
      },
    }, () => {
      const response = makeResponse();

      configHandler({
        method: 'GET',
        headers: { authorization: 'Bearer server-token' },
        body: {
          isAdmin: false,
          plan: 'free',
        },
      }, response);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'cloud_config',
        payload: {
          subject: {
            id: 'user_server',
            email: 'server@example.com',
            source: 'server_token_map',
          },
          entitlement: {
            status: 'active',
            plan: 'pro',
            capabilities: ['mcp_cloud'],
          },
        },
      });
      expect(JSON.stringify(response.body)).not.toContain('static-admin');
    });
  });
});
