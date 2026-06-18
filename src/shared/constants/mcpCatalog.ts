// ============================================================================
// MCP Catalog - 推荐 MCP Server 目录（分类 / 条目）
// ============================================================================
// 纯静态数据，main 与 renderer 共用。
// 后续运营化时由 cloudConfigService 云端下发覆盖，此处作为离线兜底默认值。
// 所有 npm 包名 / 远程 URL 均已核实存在（2026-06-03，npm view / 官方文档）。
// builtin: true 的条目对应 cloud/builtinConfig.ts BUILTIN_MCP_SERVERS 中的同 id 预置配置。
// ============================================================================

import type {
  McpCatalogPayload,
  McpCategoryMeta,
  RecommendedMcpServerEntry,
} from '../contract/mcpCatalog';

// ----------------------------------------------------------------------------
// 用途分类
// ----------------------------------------------------------------------------

export const MCP_CATEGORIES: McpCategoryMeta[] = [
  { id: 'search-scrape', label: '搜索与抓取', description: '联网搜索、网页内容提取' },
  { id: 'office-collab', label: '办公协作', description: 'Notion、飞书等协作平台' },
  { id: 'data-table', label: '数据与表格', description: 'Excel、数据库查询' },
  { id: 'browser-auto', label: '浏览器自动化', description: '网页操作、截图、表单填写' },
  { id: 'design-media', label: '设计与多媒体', description: 'Figma 设计稿读写' },
  { id: 'dev-tools', label: '开发与效率', description: 'GitHub、文档、记忆、地图' },
];

// ----------------------------------------------------------------------------
// 推荐 MCP Server
// ----------------------------------------------------------------------------

export const RECOMMENDED_MCP_SERVERS: RecommendedMcpServerEntry[] = [
  // ---- 搜索与抓取 ----
  {
    id: 'exa',
    name: 'Exa AI 搜索',
    description: 'AI 驱动的语义搜索，支持代码搜索',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: ['EXA_API_KEY'],
    badge: '全球使用量第一',
  },
  {
    id: 'tavily',
    name: 'Tavily 搜索',
    description: '实时网络搜索与新闻，支持域名过滤',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: ['TAVILY_API_KEY'],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: '标准 MCP 网页读取与内容提取',
    category: 'search-scrape',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
    },
    badge: 'Alma 官方精选·免配置',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'conditional',
    riskNote: '普通网页读取已由内置 web fetch 覆盖；需要标准 MCP workflow 时再连接。',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl 抓取',
    description: '默认网页数据层：免 key 试用搜索、网页抓取和公开 PDF 转 markdown',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: [],
    badge: '免 key 可试用',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'default_visible',
    riskNote: '免 key 模式有额度和工具范围限制；配置 FIRECRAWL_API_KEY 后获得更高额度和完整能力。',
  },
  {
    id: 'brave-search',
    name: 'Brave 搜索',
    description: '带免费额度的网页搜索',
    category: 'search-scrape',
    builtin: true,
    requiredCredentials: ['BRAVE_API_KEY'],
  },

  // ---- 办公协作 ----
  {
    id: 'notion',
    name: 'Notion',
    description: '读写 Notion 页面和数据库',
    category: 'office-collab',
    builtin: false,
    connection: {
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
    },
    requiredCredentials: ['OAuth 授权'],
    badge: 'Notion 官方',
  },
  {
    id: 'lark',
    name: '飞书',
    description: '飞书文档、消息、日历、多维表格',
    category: 'office-collab',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp'],
      env: {
        APP_ID: '',
        APP_SECRET: '',
      },
    },
    requiredCredentials: ['APP_ID', 'APP_SECRET'],
    badge: '飞书官方',
    chinaDirect: true,
  },

  // ---- 数据与表格 ----
  {
    id: 'excel',
    name: 'Excel 表格',
    description: '不装 Office 直接创建/读写 .xlsx 文件',
    category: 'data-table',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@negokaz/excel-mcp-server'],
    },
    badge: '免配置',
    chinaDirect: true,
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: '数据库管理、SQL 查询、日志分析',
    category: 'data-table',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-supabase'],
      env: {
        SUPABASE_ACCESS_TOKEN: '',
      },
    },
    requiredCredentials: ['SUPABASE_ACCESS_TOKEN'],
    badge: '官方',
  },

  // ---- 浏览器自动化 ----
  {
    id: 'playwright',
    name: 'Playwright',
    description: '浏览器自动化：打开网页、点击、截图、测试',
    category: 'browser-auto',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
    },
    badge: '微软官方·免配置',
    chinaDirect: true,
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'default_visible',
    riskNote: '和内置 Browser/Computer Use 有重叠；适合标准 MCP 浏览器自动化工作流。',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: '网页截图、PDF 生成、表单填充',
    category: 'browser-auto',
    builtin: true,
  },

  // ---- 设计与多媒体 ----
  {
    id: 'figma',
    name: 'Figma',
    description: '读写 Figma 设计稿，从设计生成代码',
    category: 'design-media',
    builtin: false,
    connection: {
      type: 'http',
      url: 'https://mcp.figma.com/mcp',
    },
    requiredCredentials: ['OAuth 授权'],
    badge: 'Figma 官方',
  },

  // ---- 开发与效率 ----
  {
    id: 'github',
    name: 'GitHub',
    description: '仓库、Issue、PR 管理',
    category: 'dev-tools',
    builtin: true,
    requiredCredentials: ['GITHUB_TOKEN'],
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'conditional',
    riskNote: '涉及仓库 token 和写权限；建议优先配置只读或最小权限 token。',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: '获取最新框架文档和代码示例',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'default_visible',
    riskNote: '适合框架文档和 API 示例查询，凭证负担低。',
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: '解读 GitHub 项目架构和文档',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
  },
  {
    id: 'memory',
    name: '知识图谱记忆',
    description: '跨会话的持久知识图谱记忆',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
  },
  {
    id: 'sequential-thinking',
    name: '分步推理',
    description: '复杂任务的动态分解和逐步推理',
    category: 'dev-tools',
    builtin: true,
    badge: '免配置',
  },
  {
    id: 'amap',
    name: '高德地图',
    description: '地图、位置查询、路径规划',
    category: 'dev-tools',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@amap/amap-maps-mcp-server'],
      env: {
        AMAP_MAPS_API_KEY: '',
      },
    },
    requiredCredentials: ['AMAP_MAPS_API_KEY'],
    badge: '高德官方',
    chinaDirect: true,
  },
  {
    id: 'task_master',
    name: 'Task Master',
    description: '项目内任务拆解、计划和执行状态管理',
    category: 'dev-tools',
    builtin: false,
    connection: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'task-master-ai'],
      env: {
        ANTHROPIC_API_KEY: '',
      },
    },
    requiredCredentials: ['ANTHROPIC_API_KEY'],
    badge: 'Alma 官方精选',
    officialFeatured: true,
    featuredSource: 'alma-mcp-registry',
    recommendationTier: 'not_default',
    riskNote: '和 code-agent 的计划/任务体系重叠；只建议已有 Task Master 项目的用户连接。',
  },
];

// ----------------------------------------------------------------------------
// Helper
// ----------------------------------------------------------------------------

/** 内置 MCP 推荐目录载荷（云端未下发时的兜底） */
export function getBuiltinMcpCatalogPayload(): McpCatalogPayload {
  return {
    categories: MCP_CATEGORIES,
    servers: RECOMMENDED_MCP_SERVERS,
  };
}

/** 按分类分组推荐 MCP server（保持分类顺序）；不传 catalog 时用内置目录 */
export function groupRecommendedMcpServersByCategory(
  catalog: McpCatalogPayload = getBuiltinMcpCatalogPayload()
): Array<{
  category: McpCategoryMeta;
  servers: RecommendedMcpServerEntry[];
}> {
  return catalog.categories.map((category) => ({
    category,
    servers: catalog.servers.filter((server) => server.category === category.id),
  })).filter((group) => group.servers.length > 0);
}

/** 根据 ID 查找推荐 MCP server；不传 servers 时在内置目录中查找 */
export function findRecommendedMcpServer(
  id: string,
  servers: RecommendedMcpServerEntry[] = RECOMMENDED_MCP_SERVERS
): RecommendedMcpServerEntry | undefined {
  return servers.find((server) => server.id === id);
}

export function getAlmaFeaturedMcpServers(
  catalog: McpCatalogPayload = getBuiltinMcpCatalogPayload()
): RecommendedMcpServerEntry[] {
  return catalog.servers.filter((server) => server.officialFeatured && server.featuredSource === 'alma-mcp-registry');
}

export function mergeMcpCatalogWithBuiltinOfficialFeatured(
  catalog: McpCatalogPayload,
): McpCatalogPayload {
  const existingIds = new Set(catalog.servers.map((server) => server.id));
  const missingFeatured = getAlmaFeaturedMcpServers(getBuiltinMcpCatalogPayload())
    .filter((server) => !existingIds.has(server.id));

  if (missingFeatured.length === 0) {
    return catalog;
  }

  return {
    ...catalog,
    servers: [
      ...catalog.servers,
      ...missingFeatured,
    ],
  };
}
