// ============================================================================
// MCP Catalog Types - MCP 推荐目录类型定义
// ============================================================================

// ----------------------------------------------------------------------------
// 用途分类
// ----------------------------------------------------------------------------

/**
 * MCP Server 用途分类
 * 按"用户要连接什么能力"划分，面向 cowork 协作者的心智模型
 */
export type McpCategory =
  | 'search-scrape' // 搜索与抓取
  | 'office-collab' // 办公协作
  | 'data-table' // 数据与表格
  | 'browser-auto' // 浏览器自动化
  | 'design-media' // 设计与多媒体
  | 'dev-tools'; // 开发与效率

/**
 * MCP 用途分类元数据（用于推荐页展示）
 */
export interface McpCategoryMeta {
  /** 分类 ID */
  id: McpCategory;
  /** 中文显示名 */
  label: string;
  /** 一句话说明 */
  description: string;
}

// ----------------------------------------------------------------------------
// 推荐条目
// ----------------------------------------------------------------------------

/**
 * MCP 连接配置模板
 * 与 renderer McpServerConfig / IPC addServer 入参形状一致
 */
export interface RecommendedMcpConnectionTemplate {
  /** 传输类型 */
  type: 'stdio' | 'sse' | 'http';
  /** stdio: 启动命令 */
  command?: string;
  /** stdio: 命令参数 */
  args?: string[];
  /** stdio: 环境变量（需要用户填的值用空字符串占位） */
  env?: Record<string, string>;
  /** sse/http: 服务地址 */
  url?: string;
  /** sse/http: 请求头（需要用户填的值用空字符串占位） */
  headers?: Record<string, string>;
}

/**
 * 推荐 MCP Server 条目
 */
export interface RecommendedMcpServerEntry {
  /**
   * server ID。与内置云端配置（builtinConfig BUILTIN_MCP_SERVERS）的 id
   * 一致时表示该 server 已随应用预置，推荐页只做展示与启用引导。
   */
  id: string;
  /** 显示名称 */
  name: string;
  /** 一句话功能描述 */
  description: string;
  /** 用途分类 */
  category: McpCategory;
  /** 是否为应用预置 server（无需添加，只需启用） */
  builtin: boolean;
  /** 连接配置模板（builtin 为 false 时必填） */
  connection?: RecommendedMcpConnectionTemplate;
  /** 需要用户提供的凭证说明（如 "EXA_API_KEY"、"OAuth 授权"），为空表示免配置 */
  requiredCredentials?: string[];
  /** 标签（如 "官方"、"免配置"） */
  badge?: string;
  /** 国内可直连（不需要代理） */
  chinaDirect?: boolean;
}
