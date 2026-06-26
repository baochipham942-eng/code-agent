// ============================================================================
// Cloud Config Service Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import type { ControlPlaneEnvelope } from '../../src/shared/contract/controlPlane';

// Mock logger
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
import { CloudConfigService, getCloudConfigService } from '../../src/host/services/cloud/cloudConfigService';
import { FeatureFlagService } from '../../src/host/services/cloud/featureFlagService';
import { getBuiltinConfig } from '../../src/host/services/cloud/builtinConfig';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../src/host/services/cloud/controlPlaneTrust';

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

function buildSignedCloudConfig(config: ReturnType<typeof getBuiltinConfig>) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope = {
    schemaVersion: 1,
    kind: 'cloud_config',
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(config),
    keyId: 'cloud-config-test-key',
    payload: config,
  };
  envelope.signature = crypto.sign(
    null,
    Buffer.from(buildControlPlaneSigningPayload(envelope)),
    privateKey,
  ).toString('base64');
  return {
    envelope,
    publicKeys: {
      'cloud-config-test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

describe('CloudConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the singleton by clearing the module cache would require more setup
    // For now, we'll test what we can
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Configuration Access Tests
  // --------------------------------------------------------------------------
  describe('配置访问', () => {
    it('getRule 对未定义 key 应该返回空字符串', () => {
      const service = getCloudConfigService();
      const rule = service.getRule('nonexistent-rule');
      expect(typeof rule).toBe('string');
    });

    it('getModelRouting 未配置时返回 undefined（消费方据此降级硬编码链）', () => {
      const service = getCloudConfigService();
      expect(service.getModelRouting()).toBeUndefined();
    });

    it('数值型 feature flag 缺失时回退到内置默认值', () => {
      const service = new FeatureFlagService({
        getFeatureFlag: () => undefined,
        isFeatureDisabledByPolicy: () => false,
      } as unknown as CloudConfigService);

      expect(service.getMaxIterations()).toBe(50);
      expect(service.getMaxMessageLength()).toBe(100000);
    });

    it('getSkills 应该返回数组', () => {
      const service = getCloudConfigService();
      const skills = service.getSkills();
      expect(Array.isArray(skills)).toBe(true);
    });

    it('getFeatureFlags 应该返回对象', () => {
      const service = getCloudConfigService();
      const flags = service.getFeatureFlags();
      expect(typeof flags).toBe('object');
      expect(flags).toHaveProperty('enableCloudAgent');
    });

    it('getConfig 应该返回完整配置', () => {
      const service = getCloudConfigService();
      const config = service.getConfig();
      expect(config).toHaveProperty('version');
      expect(config).toHaveProperty('prompts');
      expect(config).toHaveProperty('skills');
    });
  });

  // --------------------------------------------------------------------------
  // Feature Flag Tests
  // --------------------------------------------------------------------------
  describe('Feature Flags', () => {
    it('getFeatureFlag 应该返回特定 flag 值', () => {
      const service = getCloudConfigService();
      const enableCloudAgent = service.getFeatureFlag('enableCloudAgent');
      expect(typeof enableCloudAgent).toBe('boolean');
    });

    it('maxIterations 应该有默认值', () => {
      const service = getCloudConfigService();
      const flags = service.getFeatureFlags();
      expect(typeof flags.maxIterations).toBe('number');
      expect(flags.maxIterations).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Tool Meta Tests
  // --------------------------------------------------------------------------
  describe('工具元数据', () => {
    it('getToolMeta 应该返回工具元数据或 undefined', () => {
      const service = getCloudConfigService();
      const meta = service.getToolMeta('bash');
      // 可能存在或不存在
      expect(meta === undefined || typeof meta === 'object').toBe(true);
    });

    it('getAllToolMeta 应该返回对象', () => {
      const service = getCloudConfigService();
      const allMeta = service.getAllToolMeta();
      expect(typeof allMeta).toBe('object');
    });
  });

  // --------------------------------------------------------------------------
  // MCP Server Config Tests
  // --------------------------------------------------------------------------
  describe('MCP 服务器配置', () => {
    it('getMCPServers 应该返回数组', () => {
      const service = getCloudConfigService();
      const servers = service.getMCPServers();
      expect(Array.isArray(servers)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Singleton Pattern Tests
  // --------------------------------------------------------------------------
  describe('单例模式', () => {
    it('多次调用 getCloudConfigService 应该返回同一实例', () => {
      const service1 = getCloudConfigService();
      const service2 = getCloudConfigService();
      expect(service1).toBe(service2);
    });
  });

  describe('Control plane trust gate', () => {
    it('rejects unsigned fetched cloud config and falls back to builtin config', async () => {
      delete process.env.CODE_AGENT_ALLOW_UNSIGNED_CLOUD_CONFIG;
      mockFetch.mockResolvedValueOnce(mockJsonResponse({
        ...getBuiltinConfig(),
        version: 'unsigned-remote',
      }));
      const service = new CloudConfigService();

      await service.initialize();
      const info = service.getInfo();

      expect(info.fromCloud).toBe(false);
      expect(info.lastError).toContain('Rejected unsigned cloud config response');
      expect(info.trust.trusted).toBe(false);
      expect(info.trust.diagnostics.map((entry) => entry.code)).toContain('missing_control_plane_envelope');
    });

    it('sends a bearer token when fetching cloud config', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(getBuiltinConfig()));
      const service = new CloudConfigService({
        allowUnsignedCloudConfig: true,
        getAccessToken: async () => 'short-lived-token',
      });

      await service.initialize();

      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer short-lived-token',
        }),
      }));
    });

    it('does not spend the cloud config fetch timeout waiting for a slow access token', async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValueOnce(mockJsonResponse(getBuiltinConfig()));
      const service = new CloudConfigService({
        allowUnsignedCloudConfig: true,
        getAccessToken: async () => new Promise<string | null>(() => {}),
      });

      const init = service.initialize();
      await vi.advanceTimersByTimeAsync(1000);
      await init;

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, requestInit] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(requestInit.headers).not.toHaveProperty('Authorization');
      expect(service.getInfo().fromCloud).toBe(false);
      expect(service.getInfo().lastError).toBeNull();
    });

    it('accepts signed cloud config envelopes with a configured public key', async () => {
      const signedConfig = {
        ...getBuiltinConfig(),
        version: 'signed-remote',
      };
      const { envelope, publicKeys } = buildSignedCloudConfig(signedConfig);
      mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
      const service = new CloudConfigService({
        controlPlanePublicKeys: publicKeys,
      });

      await service.initialize();

      expect(service.getConfig().version).toBe('signed-remote');
      expect(service.getInfo()).toMatchObject({
        fromCloud: true,
        lastError: null,
        trust: {
          trusted: true,
          keyId: 'cloud-config-test-key',
          expiresAt: '2099-12-31T23:59:59.000Z',
          diagnostics: [],
        },
      });
    });

    it('applies signed entitlement and kill switch policy to feature flags', async () => {
      const signedConfig = {
        ...getBuiltinConfig(),
        version: 'signed-policy-remote',
        featureFlags: {
          ...getBuiltinConfig().featureFlags,
          enableCloudAgent: true,
          enableComputerUse: true,
        },
        entitlement: {
          status: 'active' as const,
          plan: 'pro',
          capabilities: ['cloud_agent'],
        },
        killSwitches: {
          global: { disabled: false },
          features: {
            enableComputerUse: {
              disabled: true,
              reason: 'controlled rollout paused',
            },
          },
        },
        release: {
          channel: 'beta' as const,
          minVersion: '0.16.75',
          forceUpdate: false,
        },
      };
      const { envelope, publicKeys } = buildSignedCloudConfig(signedConfig);
      mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
      const service = new CloudConfigService({
        controlPlanePublicKeys: publicKeys,
      });

      await service.initialize();

      const flags = new FeatureFlagService(service).getAll();
      expect(flags.enableCloudAgent).toBe(true);
      expect(flags.enableComputerUse).toBe(false);
      expect(service.isFeatureDisabledByPolicy('enableComputerUse')).toBe(true);
      expect(service.getReleasePolicy()).toMatchObject({
        channel: 'beta',
        minVersion: '0.16.75',
      });
    });

    it('fails closed for entitlement-gated features when entitlement is revoked', async () => {
      const signedConfig = {
        ...getBuiltinConfig(),
        version: 'signed-revoked-policy',
        entitlement: {
          status: 'revoked' as const,
          plan: 'pro',
          capabilities: ['*'],
          reason: 'revoked by control plane',
        },
      };
      const { envelope, publicKeys } = buildSignedCloudConfig(signedConfig);
      mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
      const service = new CloudConfigService({
        controlPlanePublicKeys: publicKeys,
      });

      await service.initialize();

      const flags = new FeatureFlagService(service).getAll();
      expect(flags.enableCloudAgent).toBe(false);
      expect(flags.enableComputerUse).toBe(false);
      expect(flags.enableMemory).toBe(false);
    });

    it('allows cloud MCP servers from signed config only when MCP entitlement is present', async () => {
      const signedConfig = {
        ...getBuiltinConfig(),
        version: 'signed-mcp-policy',
        mcpServers: [{
          id: 'cloud-search',
          name: 'Cloud Search',
          type: 'http-streamable' as const,
          enabled: true,
          config: {
            url: 'https://cloud.example.com/mcp',
          },
        }],
        entitlement: {
          status: 'active' as const,
          plan: 'pro',
          capabilities: ['mcp_cloud'],
        },
        killSwitches: {
          global: { disabled: false },
          features: {},
        },
      };
      const { envelope, publicKeys } = buildSignedCloudConfig(signedConfig);
      mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
      const service = new CloudConfigService({
        controlPlanePublicKeys: publicKeys,
      });

      await service.initialize();

      expect(service.getMCPServers()).toHaveLength(1);
      expect(service.isCloudMCPServersEnabledByPolicy()).toBe(true);
      expect(service.getCloudMCPServerPolicyBlockReason()).toBeNull();
    });

    it('fails closed for cloud MCP servers when signed entitlement omits MCP capability', async () => {
      const signedConfig = {
        ...getBuiltinConfig(),
        version: 'signed-mcp-missing-capability-policy',
        mcpServers: [{
          id: 'cloud-search',
          name: 'Cloud Search',
          type: 'http-streamable' as const,
          enabled: true,
          config: {
            url: 'https://cloud.example.com/mcp',
          },
        }],
        entitlement: {
          status: 'active' as const,
          plan: 'pro',
          capabilities: ['cloud_agent'],
        },
      };
      const { envelope, publicKeys } = buildSignedCloudConfig(signedConfig);
      mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
      const service = new CloudConfigService({
        controlPlanePublicKeys: publicKeys,
      });

      await service.initialize();

      expect(service.getMCPServers()).toHaveLength(1);
      expect(service.isCloudMCPServersEnabledByPolicy()).toBe(false);
      expect(service.getCloudMCPServerPolicyBlockReason()).toBe('missing_entitlement:mcp_cloud');
    });

    it('blocks cloud MCP servers when signed entitlement is revoked', async () => {
      const signedConfig = {
        ...getBuiltinConfig(),
        version: 'signed-mcp-revoked-policy',
        mcpServers: [{
          id: 'cloud-search',
          name: 'Cloud Search',
          type: 'http-streamable' as const,
          enabled: true,
          config: {
            url: 'https://cloud.example.com/mcp',
          },
        }],
        entitlement: {
          status: 'revoked' as const,
          plan: 'pro',
          capabilities: ['mcp_cloud'],
          reason: 'revoked by control plane',
        },
      };
      const { envelope, publicKeys } = buildSignedCloudConfig(signedConfig);
      mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
      const service = new CloudConfigService({
        controlPlanePublicKeys: publicKeys,
      });

      await service.initialize();

      expect(service.getMCPServers()).toHaveLength(1);
      expect(service.isCloudMCPServersEnabledByPolicy()).toBe(false);
      expect(service.getCloudMCPServerPolicyBlockReason()).toBe('entitlement_revoked');
    });

    it('blocks cloud MCP servers when signed global kill switch is active', async () => {
      const signedConfig = {
        ...getBuiltinConfig(),
        version: 'signed-mcp-global-kill-policy',
        mcpServers: [{
          id: 'cloud-search',
          name: 'Cloud Search',
          type: 'http-streamable' as const,
          enabled: true,
          config: {
            url: 'https://cloud.example.com/mcp',
          },
        }],
        entitlement: {
          status: 'active' as const,
          plan: 'pro',
          capabilities: ['mcp_cloud'],
        },
        killSwitches: {
          global: {
            disabled: true,
            reason: 'incident response',
          },
          features: {},
        },
      };
      const { envelope, publicKeys } = buildSignedCloudConfig(signedConfig);
      mockFetch.mockResolvedValueOnce(mockJsonResponse(envelope));
      const service = new CloudConfigService({
        controlPlanePublicKeys: publicKeys,
      });

      await service.initialize();

      expect(service.isCloudMCPServersEnabledByPolicy()).toBe(false);
      expect(service.getCloudMCPServerPolicyBlockReason()).toBe('global_kill_switch');
    });
  });
});
