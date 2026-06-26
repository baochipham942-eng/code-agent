import { describe, expect, it } from 'vitest';
import { CloudConfigService } from '../../../../src/host/services/cloud/cloudConfigService';
import { getBuiltinConfig } from '../../../../src/host/services/cloud/builtinConfig';
import type { CloudConfig } from '../../../../src/host/services/cloud/builtinConfig';
import {
  getBuiltinSkillCatalogPayload,
} from '../../../../src/shared/constants/skillCatalog';
import {
  getBuiltinMcpCatalogPayload,
} from '../../../../src/shared/constants/mcpCatalog';
import type { SkillCatalogPayload } from '../../../../src/shared/contract/skillRepository';
import type { McpCatalogPayload } from '../../../../src/shared/contract/mcpCatalog';

/** 直接注入缓存来模拟"云端已下发"的状态（绕过网络与签名校验） */
function makeServiceWithCloudConfig(overrides: Partial<CloudConfig>): CloudConfigService {
  const service = new CloudConfigService();
  const config: CloudConfig = { ...getBuiltinConfig(), ...overrides };
  // @ts-expect-error 测试访问私有字段注入缓存
  service.cache = config;
  // @ts-expect-error 测试访问私有字段
  service.cacheExpiry = Date.now() + 60_000;
  return service;
}

const CLOUD_SKILL_CATALOG: SkillCatalogPayload = {
  categories: [{ id: 'docs-office', label: '云端文档办公', description: '来自云端' }],
  skills: [
    {
      name: 'cloud-only-skill',
      displayName: '云端新技能',
      description: '只在云端目录里出现',
      category: 'docs-office',
      repoId: 'cloud-repo',
    },
  ],
  bundles: [],
  repositories: [
    {
      id: 'cloud-repo',
      name: 'Cloud Repo',
      url: 'https://github.com/example/cloud-repo',
      branch: 'main',
      skillsPath: 'skills',
      category: 'community',
      recommended: true,
    },
  ],
};

const CLOUD_MCP_CATALOG: McpCatalogPayload = {
  categories: [{ id: 'search-scrape', label: '云端搜索', description: '来自云端' }],
  servers: [
    {
      id: 'cloud-only-server',
      name: '云端新 Server',
      description: '只在云端目录里出现',
      category: 'search-scrape',
      builtin: false,
      connection: { type: 'http', url: 'https://example.com/mcp' },
    },
  ],
};

describe('cloud catalog delivery with builtin fallback', () => {
  it('falls back to builtin skill catalog when cloud config has no catalog', () => {
    const service = makeServiceWithCloudConfig({});
    expect(service.getSkillCatalog()).toEqual(getBuiltinSkillCatalogPayload());
  });

  it('falls back to builtin MCP catalog when cloud config has no catalog', () => {
    const service = makeServiceWithCloudConfig({});
    expect(service.getMcpCatalog()).toEqual(getBuiltinMcpCatalogPayload());
  });

  it('uses cloud-delivered skill catalog when present and well-formed', () => {
    const service = makeServiceWithCloudConfig({ skillCatalog: CLOUD_SKILL_CATALOG });
    const catalog = service.getSkillCatalog();
    expect(catalog.skills.map((skill) => skill.name)).toEqual(['cloud-only-skill']);
    expect(catalog.repositories.map((repo) => repo.id)).toEqual(['cloud-repo']);
  });

  it('uses cloud-delivered MCP catalog when present and well-formed', () => {
    const service = makeServiceWithCloudConfig({ mcpCatalog: CLOUD_MCP_CATALOG });
    const catalog = service.getMcpCatalog();
    expect(catalog.servers.map((server) => server.id)).toEqual(['cloud-only-server']);
  });

  it('falls back to builtin when cloud skill catalog is malformed (empty arrays)', () => {
    const service = makeServiceWithCloudConfig({
      skillCatalog: { categories: [], skills: [], bundles: [], repositories: [] },
    });
    expect(service.getSkillCatalog()).toEqual(getBuiltinSkillCatalogPayload());
  });

  it('falls back to builtin when cloud MCP catalog is malformed (missing servers)', () => {
    const service = makeServiceWithCloudConfig({
      mcpCatalog: { categories: CLOUD_MCP_CATALOG.categories, servers: [] },
    });
    expect(service.getMcpCatalog()).toEqual(getBuiltinMcpCatalogPayload());
  });
});
