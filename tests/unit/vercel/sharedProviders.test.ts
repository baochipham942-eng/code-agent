// ============================================================================
// 团队共享 provider（中转站）控制面下发 + entitlement 网关过滤测试
// 核心安全契约：中转站 apiKey 绝不下发给无权 subject。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import controlPlaneHandler from '../../../vercel-api/api/v1/control-plane';
import type { ControlPlaneResponseLike } from '../../../vercel-api/lib/controlPlaneEnvelope';

const RELAY_KEY = 'sk-test-relay-secret-key';

function createKeyPair(): string {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function makeResponse(): ControlPlaneResponseLike & { statusCode: number; body: unknown; headers: Record<string, string> } {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined,
    setHeader(name: string, value: string) {
      (this.headers as Record<string, string>)[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
    },
    end() {},
  } as ControlPlaneResponseLike & { statusCode: number; body: unknown; headers: Record<string, string> };
}

interface SharedProviderFixture {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  models: Array<{ id: string }>;
  requiredCapability?: string;
}

interface SharedServiceKeyFixture {
  service: 'brave' | 'exa' | 'openai' | 'perplexity' | 'tavily';
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
  requiredCapability?: string;
}

interface SharedProviderKeyFixture {
  provider: string;
  apiKey: string;
  requiredCapability?: string;
}

async function withEnv(
  options: {
    sharedProviders: SharedProviderFixture[];
    sharedServiceKeys?: SharedServiceKeyFixture[];
    sharedProviderKeys?: SharedProviderKeyFixture[];
    builtinCapabilities?: string[];
    entitlementRequired?: boolean;
    tokenMap?: unknown;
  },
  fn: () => Promise<void>,
): Promise<void> {
  const keys = [
    'CONTROL_PLANE_PRIVATE_KEY',
    'CONTROL_PLANE_KEY_ID',
    'CONTROL_PLANE_CLOUD_CONFIG_JSON',
    'CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
    'CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB',
    'CONTROL_PLANE_SHARED_SERVICE_KEYS_FROM_DB',
    'CONTROL_PLANE_SUPABASE_URL',
    'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CONTROL_PLANE_PRIVATE_KEY = createKeyPair();
    process.env.CONTROL_PLANE_KEY_ID = 'shared-provider-test-key';
    delete process.env.CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB;
    delete process.env.CONTROL_PLANE_SHARED_SERVICE_KEYS_FROM_DB;
    delete process.env.CONTROL_PLANE_SUPABASE_URL;
    delete process.env.CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY;
    const cloudConfig: Record<string, unknown> = {
      version: 'shared-provider-test',
      prompts: {},
      skills: [],
      toolMeta: {},
      featureFlags: {},
      uiStrings: { zh: {}, en: {} },
      rules: {},
      mcpServers: [],
      sharedProviders: options.sharedProviders,
      ...(options.sharedServiceKeys ? { sharedServiceKeys: options.sharedServiceKeys } : {}),
      ...(options.sharedProviderKeys ? { sharedProviderKeys: options.sharedProviderKeys } : {}),
    };
    if (options.builtinCapabilities) {
      cloudConfig.entitlement = {
        status: 'active',
        plan: 'static-admin',
        capabilities: options.builtinCapabilities,
      };
    }
    process.env.CONTROL_PLANE_CLOUD_CONFIG_JSON = JSON.stringify(cloudConfig);
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
    await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function payloadOf(body: unknown): {
  sharedProviders?: SharedProviderFixture[];
  sharedServiceKeys?: SharedServiceKeyFixture[];
  sharedProviderKeys?: SharedProviderKeyFixture[];
} {
  return (body as { payload: {
    sharedProviders?: SharedProviderFixture[];
    sharedServiceKeys?: SharedServiceKeyFixture[];
    sharedProviderKeys?: SharedProviderKeyFixture[];
  } }).payload;
}

const teamWide: SharedProviderFixture = {
  id: 'custom-team-relay',
  displayName: '团队共享',
  baseUrl: 'https://tokenflux.dev/v1',
  apiKey: RELAY_KEY,
  models: [{ id: 'gpt-5.3' }],
};

const gated: SharedProviderFixture = {
  ...teamWide,
  requiredCapability: 'shared_relay',
};

const teamSearchKey: SharedServiceKeyFixture = {
  service: 'tavily',
  displayName: '团队 Tavily',
  apiKey: 'tvly-test-search-secret',
};

const gatedSearchKey: SharedServiceKeyFixture = {
  ...teamSearchKey,
  requiredCapability: 'shared_search',
};

describe('control-plane sharedProviders 网关', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('开放模式：team-wide provider 连同 key 下发', async () => {
    await withEnv({ sharedProviders: [teamWide] }, async () => {
      const res = makeResponse();
      await controlPlaneHandler({ method: 'GET', query: { artifact: 'cloud_config' }, headers: {} }, res);
      expect(res.statusCode).toBe(200);
      expect(payloadOf(res.body).sharedProviders).toHaveLength(1);
      expect(JSON.stringify(res.body)).toContain(RELAY_KEY);
    });
  });

  it('开放模式且无 builtin entitlement：capability 门控的 provider 被剥离，key 不下发', async () => {
    await withEnv({ sharedProviders: [gated] }, async () => {
      const res = makeResponse();
      await controlPlaneHandler({ method: 'GET', query: { artifact: 'cloud_config' }, headers: {} }, res);
      expect(payloadOf(res.body).sharedProviders).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(RELAY_KEY);
    });
  });

  it('token_map subject 命中 capability：gated provider 连同 key 下发', async () => {
    await withEnv({
      sharedProviders: [gated],
      entitlementRequired: true,
      tokenMap: {
        'good-token': {
          subject: { id: 'user_ok', email: 'ok@example.com' },
          entitlement: { status: 'active', plan: 'team', capabilities: ['shared_relay'] },
        },
      },
    }, async () => {
      const res = makeResponse();
      await controlPlaneHandler(
        { method: 'GET', query: { artifact: 'cloud_config' }, headers: { authorization: 'Bearer good-token' } },
        res,
      );
      expect(payloadOf(res.body).sharedProviders).toHaveLength(1);
      expect(JSON.stringify(res.body)).toContain(RELAY_KEY);
    });
  });

  it('token_map subject 无 capability：gated provider 被剥离，key 绝不下发', async () => {
    await withEnv({
      sharedProviders: [gated],
      entitlementRequired: true,
      tokenMap: {
        'plain-token': {
          subject: { id: 'user_plain' },
          entitlement: { status: 'active', plan: 'free', capabilities: ['memory'] },
        },
      },
    }, async () => {
      const res = makeResponse();
      await controlPlaneHandler(
        { method: 'GET', query: { artifact: 'cloud_config' }, headers: { authorization: 'Bearer plain-token' } },
        res,
      );
      expect(payloadOf(res.body).sharedProviders).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(RELAY_KEY);
    });
  });

  it('fail-closed（要求鉴权但无 token）：剥离所有 sharedProviders，key 绝不下发', async () => {
    await withEnv({ sharedProviders: [teamWide, gated], entitlementRequired: true }, async () => {
      const res = makeResponse();
      await controlPlaneHandler({ method: 'GET', query: { artifact: 'cloud_config' }, headers: {} }, res);
      expect(payloadOf(res.body).sharedProviders).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(RELAY_KEY);
    });
  });

  it('共享搜索 key：capability 命中才下发，未命中时 key 不下发', async () => {
    await withEnv({
      sharedProviders: [],
      sharedServiceKeys: [gatedSearchKey],
      entitlementRequired: true,
      tokenMap: {
        'good-token': {
          subject: { id: 'user_ok' },
          entitlement: { status: 'active', plan: 'team', capabilities: ['shared_search'] },
        },
        'plain-token': {
          subject: { id: 'user_plain' },
          entitlement: { status: 'active', plan: 'free', capabilities: ['memory'] },
        },
      },
    }, async () => {
      const good = makeResponse();
      await controlPlaneHandler(
        { method: 'GET', query: { artifact: 'cloud_config' }, headers: { authorization: 'Bearer good-token' } },
        good,
      );
      expect(payloadOf(good.body).sharedServiceKeys).toHaveLength(1);
      expect(JSON.stringify(good.body)).toContain(teamSearchKey.apiKey);

      const plain = makeResponse();
      await controlPlaneHandler(
        { method: 'GET', query: { artifact: 'cloud_config' }, headers: { authorization: 'Bearer plain-token' } },
        plain,
      );
      expect(payloadOf(plain.body).sharedServiceKeys).toBeUndefined();
      expect(JSON.stringify(plain.body)).not.toContain(teamSearchKey.apiKey);
    });
  });

  it('fail-closed（要求鉴权但无 token）：剥离所有共享搜索 key', async () => {
    await withEnv({
      sharedProviders: [],
      sharedServiceKeys: [teamSearchKey, gatedSearchKey],
      entitlementRequired: true,
    }, async () => {
      const res = makeResponse();
      await controlPlaneHandler({ method: 'GET', query: { artifact: 'cloud_config' }, headers: {} }, res);
      expect(payloadOf(res.body).sharedServiceKeys).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(teamSearchKey.apiKey);
    });
  });
  it('内置 provider 托管 key（MiMo）：登录 subject 即下发（team-wide 登录后可用）', async () => {
    await withEnv({
      sharedProviders: [],
      sharedProviderKeys: [{ provider: 'xiaomi', apiKey: 'sk-mimo-team-secret' }],
      entitlementRequired: true,
      tokenMap: {
        'good-token': {
          subject: { id: 'user_ok' },
          entitlement: { status: 'active', plan: 'free', capabilities: [] },
        },
      },
    }, async () => {
      const res = makeResponse();
      await controlPlaneHandler(
        { method: 'GET', query: { artifact: 'cloud_config' }, headers: { authorization: 'Bearer good-token' } },
        res,
      );
      expect(payloadOf(res.body).sharedProviderKeys).toHaveLength(1);
      expect(JSON.stringify(res.body)).toContain('sk-mimo-team-secret');
    });
  });

  it('内置 provider 托管 key：fail-closed 未登录绝不下发', async () => {
    await withEnv({
      sharedProviders: [],
      sharedProviderKeys: [{ provider: 'xiaomi', apiKey: 'sk-mimo-team-secret' }],
      entitlementRequired: true,
    }, async () => {
      const res = makeResponse();
      await controlPlaneHandler({ method: 'GET', query: { artifact: 'cloud_config' }, headers: {} }, res);
      expect(payloadOf(res.body).sharedProviderKeys).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('sk-mimo-team-secret');
    });
  });

  it('内置 provider 托管 key：capability 门控未命中被剥离', async () => {
    await withEnv({
      sharedProviders: [],
      sharedProviderKeys: [{ provider: 'xiaomi', apiKey: 'sk-mimo-team-secret', requiredCapability: 'shared_mimo' }],
      entitlementRequired: true,
      tokenMap: {
        'plain-token': {
          subject: { id: 'user_plain' },
          entitlement: { status: 'active', plan: 'free', capabilities: ['memory'] },
        },
      },
    }, async () => {
      const res = makeResponse();
      await controlPlaneHandler(
        { method: 'GET', query: { artifact: 'cloud_config' }, headers: { authorization: 'Bearer plain-token' } },
        res,
      );
      expect(payloadOf(res.body).sharedProviderKeys).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('sk-mimo-team-secret');
    });
  });
});
