// ============================================================================
// 混合方案：共享 provider 配置从 Supabase 读、key 从 Vercel env 取。
// 验证 key 永不入表（表只给 api_key_env 变量名）+ 全链路走 entitlement 网关下发。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import { loadSharedProvidersFromStore } from '../../../vercel-api/lib/controlPlaneSharedProviders';
import controlPlaneHandler from '../../../vercel-api/api/v1/control-plane';
import type { ControlPlaneResponseLike } from '../../../vercel-api/lib/controlPlaneEnvelope';

const RELAY_KEY = 'sk-store-relay-secret';

function makeResponse(): ControlPlaneResponseLike & { statusCode: number; body: unknown } {
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
  } as ControlPlaneResponseLike & { statusCode: number; body: unknown };
}

describe('loadSharedProvidersFromStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('未配置 Supabase 时返回 null（调用方保留 env-JSON 兜底）', async () => {
    const result = await loadSharedProvidersFromStore({} as NodeJS.ProcessEnv);
    expect(result).toBeNull();
  });

  it('从 DB 读配置 + 从 env 取 key；env 缺 key 的行被跳过；key 不来自表', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'custom-team-relay',
          display_name: '团队共享',
          base_url: 'https://tokenflux.dev/v1',
          protocol: 'openai',
          billing_mode: 'unknown',
          models: [{ id: 'gpt-5.5' }],
          required_capability: 'shared_relay',
          api_key_env: 'TEST_RELAY_KEY', // 表里只有变量名，没有 key
        },
        {
          id: 'custom-no-key',
          display_name: '没配 key 的',
          base_url: 'https://x/v1',
          models: [{ id: 'm' }],
          api_key_env: 'TEST_MISSING_KEY', // env 里没有 → 跳过
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB: '1',
      CONTROL_PLANE_SUPABASE_URL: 'https://proj.supabase.co',
      CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      TEST_RELAY_KEY: RELAY_KEY,
    } as unknown as NodeJS.ProcessEnv;

    const result = await loadSharedProvidersFromStore(env);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      id: 'custom-team-relay',
      displayName: '团队共享',
      baseUrl: 'https://tokenflux.dev/v1',
      apiKey: RELAY_KEY, // 从 env 注入
      requiredCapability: 'shared_relay',
      models: [{ id: 'gpt-5.5' }],
    });
    // 查询用了 enabled 过滤 + service role 头
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('control_plane_shared_providers');
    expect(String(calledUrl)).toContain('enabled=eq.true');
    expect((calledInit as { headers: Record<string, string> }).headers.apikey).toBe('service-role-key');
  });
});

describe('cloud_config 全链路（DB 配置 + env key + entitlement 网关）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('命中 capability 的 subject：DB 来的共享 provider 连同 env 里的 key 下发', async () => {
    const keys = [
      'CONTROL_PLANE_PRIVATE_KEY',
      'CONTROL_PLANE_KEY_ID',
      'CONTROL_PLANE_CLOUD_CONFIG_JSON',
      'CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB',
      'CONTROL_PLANE_SUPABASE_URL',
      'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
      'TEST_RELAY_KEY',
    ];
    const previous = new Map(keys.map((k) => [k, process.env[k]]));
    try {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      process.env.CONTROL_PLANE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      process.env.CONTROL_PLANE_KEY_ID = 'store-test-key';
      process.env.CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB = '1';
      process.env.CONTROL_PLANE_CLOUD_CONFIG_JSON = JSON.stringify({
        version: 'store-test',
        prompts: {},
        skills: [],
        toolMeta: {},
        featureFlags: {},
        uiStrings: { zh: {}, en: {} },
        rules: {},
        mcpServers: [],
        // 注意：env-JSON 里没有 sharedProviders，全部来自 DB
      });
      process.env.CONTROL_PLANE_SUPABASE_URL = 'https://proj.supabase.co';
      process.env.CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
      process.env.TEST_RELAY_KEY = RELAY_KEY;

      // 调用顺序：1) 读共享 provider 表  2) 校验 JWT 取 subject  3) 查 entitlement
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{
            id: 'custom-team-relay',
            display_name: '团队共享',
            base_url: 'https://tokenflux.dev/v1',
            protocol: 'openai',
            billing_mode: 'unknown',
            models: [{ id: 'gpt-5.5' }],
            required_capability: 'shared_relay',
            api_key_env: 'TEST_RELAY_KEY',
          }],
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'user_ok', email: 'ok@example.com' }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ status: 'active', plan: 'team', capabilities: ['shared_relay'], expires_at: '2099-01-01T00:00:00Z' }],
        });
      vi.stubGlobal('fetch', fetchMock);

      const res = makeResponse();
      await controlPlaneHandler(
        { method: 'GET', query: { artifact: 'cloud_config' }, headers: { authorization: 'Bearer user-token' } },
        res,
      );

      expect(res.statusCode).toBe(200);
      const payload = (res.body as { payload: { sharedProviders?: Array<{ id: string; apiKey: string }> } }).payload;
      expect(payload.sharedProviders).toHaveLength(1);
      expect(payload.sharedProviders![0]).toMatchObject({ id: 'custom-team-relay', apiKey: RELAY_KEY });
    } finally {
      for (const k of keys) {
        const v = previous.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
