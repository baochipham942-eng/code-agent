// ============================================================================
// Alma MCP Registry - reviewed featured registry adapter
// ============================================================================
// The remote Alma registry can drift. Keep a reviewed featured fallback and a
// small normalizer so Settings can distinguish official featured from defaults.
// ============================================================================

export const ALMA_MCP_REGISTRY_REVIEWED_AT = '2026-06-13';

export interface AlmaMcpRegistryPayload {
  version?: string;
  servers?: AlmaMcpRegistryServer[];
}

export interface AlmaMcpRegistryServer {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  featured?: boolean;
  verified?: boolean;
  tags?: string[];
  installations?: Array<{
    type?: string;
    command?: string;
    args?: string[];
    url?: string;
  }>;
  requiredParameters?: string[];
  requiredCredentials?: string[];
}

export interface AlmaMcpFeaturedServerSnapshot {
  id: string;
  name: string;
  category?: string;
  description?: string;
  verified?: boolean;
  installTypes: string[];
  requiredCredentials: string[];
}

export const ALMA_MCP_FEATURED_FALLBACK: AlmaMcpFeaturedServerSnapshot[] = [
  {
    id: 'context7',
    name: 'Context7',
    category: 'development',
    description: '获取最新框架文档和代码示例。',
    verified: true,
    installTypes: ['npx', 'remote'],
    requiredCredentials: [],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    category: 'web-scraping',
    description: '标准 MCP 网页读取与内容提取。',
    verified: true,
    installTypes: ['uvx', 'docker', 'proxy'],
    requiredCredentials: [],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl MCP Server',
    category: 'web-scraping',
    description: '免 key 可试用搜索和网页抓取；配置 key 后支持更高额度和完整能力。',
    verified: true,
    installTypes: ['npx', 'self-hosted'],
    requiredCredentials: [],
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'development',
    description: '仓库、Issue、PR 管理。',
    verified: true,
    installTypes: ['remote', 'docker'],
    requiredCredentials: ['GITHUB_TOKEN'],
  },
  {
    id: 'playwright',
    name: 'Playwright MCP',
    category: 'browser-automation',
    description: '浏览器自动化、截图和网页测试。',
    verified: true,
    installTypes: ['npx', 'vision', 'sse', 'docker'],
    requiredCredentials: [],
  },
  {
    id: 'task_master',
    name: 'Task Master',
    category: 'project-management',
    description: '项目内任务拆解、计划和执行状态管理。',
    verified: false,
    installTypes: ['npx'],
    requiredCredentials: ['ANTHROPIC_API_KEY'],
  },
];

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(values.map(normalizeString).filter((value): value is string => Boolean(value))));
}

function normalizeInstallTypes(server: AlmaMcpRegistryServer): string[] {
  return Array.from(new Set((server.installations || [])
    .map((installation) => normalizeString(installation.type))
    .filter((value): value is string => Boolean(value))));
}

export function normalizeAlmaMcpFeaturedServers(
  payload?: AlmaMcpRegistryPayload,
): AlmaMcpFeaturedServerSnapshot[] {
  const servers = payload?.servers;
  if (!Array.isArray(servers)) {
    return ALMA_MCP_FEATURED_FALLBACK;
  }

  return servers
    .filter((server) => server.featured === true)
    .flatMap((server) => {
      const id = normalizeString(server.id) || normalizeString(server.name);
      const name = normalizeString(server.name) || id;
      if (!id || !name) {
        return [];
      }

      const snapshot: AlmaMcpFeaturedServerSnapshot = {
        id,
        name,
        installTypes: normalizeInstallTypes(server),
        requiredCredentials: [
          ...normalizeStringArray(server.requiredCredentials),
          ...normalizeStringArray(server.requiredParameters),
        ],
      };
      const category = normalizeString(server.category);
      const description = normalizeString(server.description);
      if (category) {
        snapshot.category = category;
      }
      if (description) {
        snapshot.description = description;
      }
      if (typeof server.verified === 'boolean') {
        snapshot.verified = server.verified;
      }
      return [snapshot];
    });
}
