// ============================================================================
// Cloud Config Service Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../src/main/services/infra/logger', () => ({
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
import { getCloudConfigService } from '../../src/main/services/cloud/cloudConfigService';

describe('CloudConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the singleton by clearing the module cache would require more setup
    // For now, we'll test what we can
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Configuration Access Tests
  // --------------------------------------------------------------------------
  describe('配置访问', () => {
    it('getPrompt 应该返回字符串', () => {
      const service = getCloudConfigService();
      const prompt = service.getPrompt('gen4');
      expect(typeof prompt).toBe('string');
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
      expect(flags).toHaveProperty('enableGen8');
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
      const enableGen8 = service.getFeatureFlag('enableGen8');
      expect(typeof enableGen8).toBe('boolean');
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
});
