import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function withControlPlaneEnv(fn: () => void | Promise<void>): Promise<void> {
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
    await fn();
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

async function withCloudConfigEnv(options: {
  entitlementRequired?: boolean;
  tokenMap?: unknown;
  supabase?: {
    url: string;
    key: string;
  };
}, fn: () => void | Promise<void>): Promise<void> {
  const keys = [
    'CONTROL_PLANE_PRIVATE_KEY',
    'CONTROL_PLANE_KEY_ID',
    'CONTROL_PLANE_CLOUD_CONFIG_JSON',
    'CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
    'CONTROL_PLANE_SUPABASE_URL',
    'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
    'CONTROL_PLANE_SUPABASE_KEY',
    'CONTROL_PLANE_SUPABASE_ANON_KEY',
    'CONTROL_PLANE_SUPABASE_ENTITLEMENT_REQUIRED',
    'CONTROL_PLANE_ENTITLEMENT_SUPABASE_REQUIRED',
    'CONTROL_PLANE_SUPABASE_ENTITLEMENT_TABLE',
    'CONTROL_PLANE_SUPABASE_ENTITLEMENT_USER_ID_COLUMN',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_URL',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_KEY',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_ANON_KEY',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_ENTITLEMENT_REQUIRED',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_SUPABASE_REQUIRED',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_ENTITLEMENT_TABLE',
    'CODE_AGENT_CONTROL_PLANE_SUPABASE_ENTITLEMENT_USER_ID_COLUMN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_KEY',
    'SUPABASE_ANON_KEY',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) {
      delete process.env[key];
    }
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
    if (options.supabase) {
      process.env.CONTROL_PLANE_SUPABASE_URL = options.supabase.url;
      process.env.CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY = options.supabase.key;
    }
    await fn();
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves capability registry through the unified control-plane route', async () => {
    await withControlPlaneEnv(async () => {
      const response = makeResponse();

      await controlPlaneHandler({
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

  it('serves capability registry through the direct v1 capabilities route', async () => {
    await withControlPlaneEnv(async () => {
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

  it('fails closed for cloud config entitlement when auth is required and no token is provided', async () => {
    await withCloudConfigEnv({ entitlementRequired: true }, async () => {
      const response = makeResponse();

      await controlPlaneHandler({
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

  it('fails closed for cloud config entitlement when token is invalid and ignores client plan claims', async () => {
    await withCloudConfigEnv({
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
    }, async () => {
      const response = makeResponse();

      await controlPlaneHandler({
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

  it('serves active cloud config entitlement only for a server-side mapped subject', async () => {
    await withCloudConfigEnv({
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
    }, async () => {
      const response = makeResponse();

      await configHandler({
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

  it('serves cloud config entitlement from Supabase for a verified subject', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: 'user_supabase',
          email: 'supabase@example.com',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([{
          status: 'active',
          plan: 'pro',
          capabilities: ['mcp_cloud'],
          expires_at: '2099-01-01T00:00:00.000Z',
        }]),
      });
    vi.stubGlobal('fetch', fetchMock);

    await withCloudConfigEnv({
      supabase: {
        url: 'https://project.supabase.co',
        key: 'service-role-key',
      },
    }, async () => {
      const response = makeResponse();

      await controlPlaneHandler({
        method: 'GET',
        query: { artifact: 'cloud_config' },
        headers: { authorization: 'Bearer supabase-access-token' },
        body: {
          plan: 'enterprise',
          capabilities: ['*'],
        },
      }, response);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://project.supabase.co/auth/v1/user',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer supabase-access-token',
            apikey: 'service-role-key',
          }),
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('https://project.supabase.co/rest/v1/control_plane_entitlements'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer service-role-key',
            apikey: 'service-role-key',
          }),
        }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'cloud_config',
        payload: {
          subject: {
            id: 'user_supabase',
            email: 'supabase@example.com',
            source: 'supabase_auth',
          },
          entitlement: {
            status: 'active',
            plan: 'pro',
            capabilities: ['mcp_cloud'],
          },
        },
      });
      expect(JSON.stringify(response.body)).not.toContain('static-admin');
      expect(JSON.stringify(response.body)).not.toContain('enterprise');
    });
  });

  it('fails closed for a Supabase-verified subject without an entitlement row', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: 'user_without_entitlement',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([]),
      }));

    await withCloudConfigEnv({
      supabase: {
        url: 'https://project.supabase.co',
        key: 'service-role-key',
      },
    }, async () => {
      const response = makeResponse();

      await configHandler({
        method: 'GET',
        headers: { authorization: 'Bearer supabase-access-token' },
      }, response);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'cloud_config',
        payload: {
          entitlement: {
            status: 'revoked',
            plan: 'unauthenticated',
            capabilities: [],
            reason: 'missing_supabase_entitlement',
          },
        },
      });
    });
  });

  it('fails closed for cloud config entitlement when Supabase verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: 'invalid JWT' }),
    }));

    await withCloudConfigEnv({
      supabase: {
        url: 'https://project.supabase.co',
        key: 'service-role-key',
      },
    }, async () => {
      const response = makeResponse();

      await configHandler({
        method: 'GET',
        headers: { authorization: 'Bearer bad-supabase-token' },
        body: {
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
});
