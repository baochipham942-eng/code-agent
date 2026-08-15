// ============================================================================
// Builtin Config - 内置配置（云端不可用时的降级方案）
// ============================================================================

import type { SkillDefinition } from '../../../shared/contract';
import type { SkillCatalogPayload } from '../../../shared/contract/skillRepository';
import type { McpCatalogPayload } from '../../../shared/contract/mcpCatalog';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ToolMetadata {
  name: string;
  description: string;
  version?: string;
}

export interface FeatureFlags {
  enableCloudAgent: boolean;
  enableMemory: boolean;
  enableComputerUse: boolean;
  maxIterations: number;
  maxMessageLength: number;
  enableExperimentalTools: boolean;
  nativeGenerativeUI: boolean;
  executionManifestV1: boolean;
}

export type EntitlementStatus = 'active' | 'trial' | 'expired' | 'revoked';
export type ReleaseChannel = 'stable' | 'beta' | 'canary';

export interface EntitlementPolicy {
  status: EntitlementStatus;
  plan: string;
  capabilities: string[];
  expiresAt?: string;
  reason?: string;
}

export interface KillSwitchState {
  disabled: boolean;
  reason?: string;
}

export interface KillSwitchPolicy {
  global?: KillSwitchState;
  features?: Record<string, KillSwitchState>;
}

export interface ReleasePolicy {
  channel: ReleaseChannel;
  minVersion?: string;
  latestVersion?: string;
  forceUpdate?: boolean;
  updateManifestUrl?: string;
  downloadUrl?: string;
  sha256?: string;
}

// 模型路由 override：控制面下发后可改 Vercel env 即换模型/调降级链，无需发版。
// 缺省 / 畸形时消费方（modelRouterPolicy.resolveBaseFallbackChain）降级硬编码 PROVIDER_FALLBACK_CHAIN。
export interface ModelRoutingConfig {
  fallbackChain?: Record<string, Array<{ provider: string; model: string }>>;
}

// MCP Server 配置
export interface MCPServerCloudConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'http-streamable';
  enabled: boolean;
  config: {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  requiredEnvVars?: string[];
  description?: string;
}

/**
 * 团队共享 provider（中转站）下发配置。镜像 vercel-api 的 SharedProviderConfig。
 * 控制面已按 subject 的 entitlement 在网关层过滤——客户端拿到的就是「本人有权使用」的那几条，
 * 直接注入模型选择器即可，无需再做权限判断。
 */
export interface SharedProviderConfig {
  /** 必须是动态 custom provider 形态（custom-xxx）。 */
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  protocol?: 'openai' | 'claude';
  billingMode?: 'free' | 'plan' | 'payg' | 'unknown';
  models: Array<{ id: string; label?: string }>;
  requiredCapability?: string;
}

export type SharedServiceKeyName = 'brave' | 'exa' | 'firecrawl' | 'openai' | 'perplexity' | 'tavily';

/**
 * 团队共享服务 key（先用于联网搜索）。控制面已按 entitlement 过滤，客户端仅把 key
 * 作为用户未自配该服务 key 时的 fallback，不覆盖用户自己的 SecureStorage key。
 */
export interface SharedServiceKeyConfig {
  service: SharedServiceKeyName;
  apiKey: string;
  /** Stable non-secret id derived by control-plane for ops/quota state. */
  keyId?: string;
  /** Optional OpenAI-compatible base URL for services backed by a relay/NewAPI endpoint. */
  baseUrl?: string;
  displayName?: string;
  requiredCapability?: string;
}

/**
 * 内置 provider 的托管 key（先用于 xiaomi/MiMo）。与 sharedProviders（custom-xxx 中转站）
 * 不同：不新增 provider 条目，而是给内置 provider 注入团队共享 key，让全新机器登录后
 * 开箱即用。控制面已按 entitlement 过滤（登录后下发）；客户端仅作用户未自配 key 时的
 * fallback，并按白名单 reconcile，停发即吊销。
 */
export interface SharedProviderKeyConfig {
  /** 内置 provider id（如 'xiaomi'）；客户端按白名单接受。 */
  provider: string;
  apiKey: string;
  /** Stable non-secret id derived by control-plane for ops/quota state. */
  keyId?: string;
  requiredCapability?: string;
}

export interface CloudConfig {
  version: string;
  prompts: Record<string, string>;
  skills: SkillDefinition[];
  toolMeta: Record<string, ToolMetadata>;
  featureFlags: FeatureFlags;
  uiStrings: {
    zh: Record<string, string>;
    en: Record<string, string>;
  };
  mcpServers: MCPServerCloudConfig[];
  entitlement?: EntitlementPolicy;
  killSwitches?: KillSwitchPolicy;
  release?: ReleasePolicy;
  /** 模型路由 override（运营下发；缺省/畸形时降级硬编码 PROVIDER_FALLBACK_CHAIN） */
  modelRouting?: ModelRoutingConfig;
  /** Skill 推荐目录（运营下发；缺省时客户端用内置兜底） */
  skillCatalog?: SkillCatalogPayload;
  /** MCP 推荐目录（运营下发；缺省时客户端用内置兜底） */
  mcpCatalog?: McpCatalogPayload;
  /** 团队共享 provider（中转站）；控制面已按 entitlement 过滤，客户端直接注入选择器。 */
  sharedProviders?: SharedProviderConfig[];
  /** 团队共享服务 key（如 Tavily/Brave 搜索），按 entitlement 过滤后下发。 */
  sharedServiceKeys?: SharedServiceKeyConfig[];
  /** 内置 provider 托管 key（如 xiaomi/MiMo），按 entitlement 过滤后下发（登录后）。 */
  sharedProviderKeys?: SharedProviderKeyConfig[];
}

// ----------------------------------------------------------------------------
// Skills
// ----------------------------------------------------------------------------

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: 'file-organizer',
    description: '整理目录中的文件：按类型分类、检测重复、排序文件',
    prompt: `你是一个文件整理助手。帮助用户整理指定目录中的文件。

## 工作流程

### 1. 确认目标目录
- 如果用户指定了目录，使用该目录
- 如果没有指定，使用 ask_user_question 询问用户要整理哪个目录

### 2. 分析目录内容
- 使用 bash 执行 \`ls -la\` 查看目录内容
- 统计文件类型分布（按扩展名）

### 3. 检测重复文件
- 使用 bash 执行 md5 校验来检测重复文件

### 4. 生成整理报告

### 5. 执行整理操作（需要用户确认）
- 移动文件前，先使用 ask_user_question 询问用户确认
- 删除文件前，**必须**使用 ask_user_question 获得用户明确同意`,
    tools: ['bash', 'read_file', 'list_directory', 'glob', 'ask_user_question'],
  },
  {
    name: 'commit',
    description: 'Create a git commit following best practices',
    prompt: `You are a git commit assistant. Create a well-structured git commit:

1. First run 'git status' to see all changes
2. Run 'git diff --staged' to see staged changes
3. Write a commit message following conventional commit format
4. Stage files if needed with 'git add'
5. Create the commit with 'git commit -m "message"'`,
    tools: ['bash', 'read_file'],
  },
  {
    name: 'reviewer',
    description: 'Review code for bugs, security issues, and best practices',
    prompt: `You are a code review assistant. Review the code changes thoroughly.`,
    tools: ['bash', 'read_file', 'glob', 'grep'],
  },
  {
    name: 'test',
    description: 'Run and analyze tests',
    prompt: `You are a test runner assistant. Run and analyze the test suite.`,
    tools: ['bash', 'read_file', 'glob'],
  },
  {
    name: 'feature-dev',
    description: 'Guided feature development workflow',
    prompt: `You are a feature development assistant. Help develop a new feature.`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
  },
];

// ----------------------------------------------------------------------------
// Tool Metadata
// ----------------------------------------------------------------------------

// ⚠️ 这里的键**绝不能与任何工具 schema 名大小写完全一致**。
// `schemaToDefinition`（tools/dispatch/toolDefinitions.ts:63）的合并顺序是
// `cloud?.description || schema.dynamicDescription?.() || schema.description`——cloud 最优先，
// 所以一条命中的一句话兜底描述会把那个工具**整份 description 顶掉且不报错**，
// 模型从此看不到它真正的使用规则。门在 tests/unit/tools/builtinToolMetaOverride.test.ts。
//
// 2026-08-14（L8 N-L8-RULES-SINK）按这条判据删掉 4 条已经命中的：
//   Task（顶掉整段委派路由规则 + renderAgentCatalogSection 动态渲染的子代理目录）
//   web_fetch（顶掉「认证/私有 URL 必失败」这条 IMPORTANT 警告）
//   read_pdf / mcp（各自顶掉完整参数与用法说明）
// 剩下的 bash / read_file / glob / … 是历史小写名，与现在的 Bash / Read / Glob 大小写不符，
// 查不中所以无害；留着是给远端下发同名 override 时兜底。
const BUILTIN_TOOL_META: Record<string, ToolMetadata> = {
  bash: { name: 'bash', description: '执行 shell 命令', version: '1.0.0' },
  read_file: { name: 'read_file', description: '读取文件内容', version: '1.0.0' },
  write_file: { name: 'write_file', description: '创建或覆盖文件', version: '1.0.0' },
  edit_file: { name: 'edit_file', description: '编辑文件的特定部分', version: '1.0.0' },
  glob: { name: 'glob', description: '按模式搜索文件', version: '1.0.0' },
  grep: { name: 'grep', description: '在文件中搜索内容', version: '1.0.0' },
  list_directory: { name: 'list_directory', description: '列出目录内容', version: '1.0.0' },
  // todo_write: { name: 'todo_write', description: '管理任务列表', version: '1.0.0' }, // 已移除
  ask_user_question: { name: 'ask_user_question', description: '向用户提问', version: '1.0.0' },
  skill: { name: 'skill', description: '调用预定义技能', version: '1.0.0' },
};

// ----------------------------------------------------------------------------
// Feature Flags
// ----------------------------------------------------------------------------

const BUILTIN_FEATURE_FLAGS: FeatureFlags = {
  enableCloudAgent: true,
  enableMemory: true,
  enableComputerUse: true,
  maxIterations: 50,
  maxMessageLength: 100000,
  enableExperimentalTools: false,
  nativeGenerativeUI: false,
  executionManifestV1: false,
};

const BUILTIN_ENTITLEMENT: EntitlementPolicy = {
  status: 'active',
  plan: 'local',
  capabilities: ['*'],
};

const BUILTIN_KILL_SWITCHES: KillSwitchPolicy = {
  global: { disabled: false },
  features: {},
};

const BUILTIN_RELEASE_POLICY: ReleasePolicy = {
  channel: 'stable',
};

// ----------------------------------------------------------------------------
// UI Strings
// ----------------------------------------------------------------------------

const BUILTIN_UI_STRINGS = {
  zh: {
    'common.save': '保存',
    'common.cancel': '取消',
    'common.confirm': '确认',
    'common.delete': '删除',
    'common.edit': '编辑',
    'common.copy': '复制',
    'common.loading': '加载中...',
    'common.error': '错误',
    'common.success': '成功',
    'common.refresh': '刷新',
    'settings.title': '设置',
    'settings.model': '模型设置',
    'settings.apiKey': 'API 密钥',
    'settings.refreshConfig': '刷新配置',
    'settings.configVersion': '配置版本',
    'chat.placeholder': '输入消息...',
    'chat.send': '发送',
    'chat.stop': '停止',
    'chat.clear': '清空对话',
    'tool.executing': '执行中',
    'tool.completed': '已完成',
    'tool.failed': '失败',
    'permission.allow': '允许',
    'permission.deny': '拒绝',
    'permission.allowSession': '本次会话允许',
  },
  en: {
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.copy': 'Copy',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.success': 'Success',
    'common.refresh': 'Refresh',
    'settings.title': 'Settings',
    'settings.model': 'Model Settings',
    'settings.apiKey': 'API Key',
    'settings.refreshConfig': 'Refresh Config',
    'settings.configVersion': 'Config Version',
    'chat.placeholder': 'Type a message...',
    'chat.send': 'Send',
    'chat.stop': 'Stop',
    'chat.clear': 'Clear Chat',
    'tool.executing': 'Executing',
    'tool.completed': 'Completed',
    'tool.failed': 'Failed',
    'permission.allow': 'Allow',
    'permission.deny': 'Deny',
    'permission.allowSession': 'Allow for Session',
  },
};

// ----------------------------------------------------------------------------
// MCP Servers
// ----------------------------------------------------------------------------

const BUILTIN_MCP_SERVERS: MCPServerCloudConfig[] = [
  // ========== HTTP Streamable 远程服务器 (推荐) ==========

  {
    id: 'context7',
    name: 'Context7',
    type: 'http-streamable',
    enabled: true,
    config: {
      url: 'https://mcp.context7.com/mcp',
      headers: {
        'CONTEXT7_API_KEY': '${CONTEXT7_API_KEY}',
      },
    },
    requiredEnvVars: [],  // API key optional but recommended for higher rate limits
    description: '获取最新的库/框架文档和代码示例，解决 LLM 训练数据过时问题',
  },
  {
    id: 'exa',
    name: 'Exa AI Search',
    type: 'http-streamable',
    enabled: true,  // Enable if EXA_API_KEY is set
    config: {
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa',
      headers: {
        'x-api-key': '${EXA_API_KEY}',
      },
    },
    requiredEnvVars: ['EXA_API_KEY'],
    description: 'AI 驱动的网络搜索，支持语义搜索和代码搜索',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    type: 'http-streamable',
    enabled: true,
    config: {
      url: 'https://mcp.firecrawl.dev/v2/mcp',
      headers: {},
    },
    requiredEnvVars: [],
    description: '默认网页数据层；免 key 可试用搜索和网页抓取，配置 Firecrawl key 后额度更稳',
  },
  {
    id: 'tavily',
    name: 'Tavily Search',
    type: 'http-streamable',
    enabled: true,  // Enable if TAVILY_API_KEY is set
    config: {
      // Tavily remote MCP accepts a Bearer API key (or URL query parameter).
      url: 'https://mcp.tavily.com/mcp/',
      headers: {
        'Authorization': 'Bearer ${TAVILY_API_KEY}',
      },
    },
    requiredEnvVars: ['TAVILY_API_KEY'],
    description: 'AI 驱动的实时网络搜索和内容提取，支持新闻搜索和域名过滤',
  },

  // ========== SSE 远程服务器 ==========

  {
    id: 'deepwiki',
    name: 'DeepWiki',
    type: 'sse',
    enabled: true,
    config: {
      url: 'https://mcp.deepwiki.com/sse',
    },
    description: '解读 GitHub 项目文档，提供项目架构和代码理解',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    type: 'stdio',
    enabled: false,
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '~'],
    },
    description: '文件系统访问（默认禁用，避免与内置工具冲突）',
  },
  {
    id: 'git',
    name: 'Git',
    type: 'stdio',
    enabled: false,
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git'],
    },
    description: 'Git 版本控制操作',
  },
  {
    id: 'github',
    name: 'GitHub',
    type: 'stdio',
    enabled: false,
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}',
      },
    },
    requiredEnvVars: ['GITHUB_TOKEN'],
    description: 'GitHub API 访问（需要 GITHUB_TOKEN）',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    type: 'stdio',
    enabled: false,
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: {
        BRAVE_API_KEY: '${BRAVE_API_KEY}',
      },
    },
    requiredEnvVars: ['BRAVE_API_KEY'],
    description: '网络搜索（需要 BRAVE_API_KEY）',
  },
  {
    id: 'memory',
    name: 'Memory',
    type: 'stdio',
    enabled: false,
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    description: '知识图谱记忆服务',
  },
  // ========== Phase 1: Sequential Thinking ==========
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    type: 'stdio',
    enabled: true,
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    description: '动态问题分解和逐步推理，适合复杂任务规划',
  },
  // ========== Phase 3: Puppeteer ==========
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    type: 'stdio',
    enabled: false,
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    },
    description: '浏览器自动化，支持网页截图、PDF 生成、表单填充',
  },
  // ========== Phase 3: Docker ==========
  {
    id: 'docker',
    name: 'Docker',
    type: 'stdio',
    enabled: false,
    config: {
      command: 'npx',
      args: ['-y', 'mcp-server-docker'],
    },
    description: '容器管理，支持 Docker 镜像和容器操作',
  },
];

// ----------------------------------------------------------------------------
// Export Builtin Config
// ----------------------------------------------------------------------------

// 内置配置版本 - 与云端保持同步
const BUILTIN_VERSION = '2025.01.19.1';

export function getBuiltinConfig(): CloudConfig {
  return {
    version: BUILTIN_VERSION,
    prompts: {},
    skills: BUILTIN_SKILLS,
    toolMeta: BUILTIN_TOOL_META,
    featureFlags: BUILTIN_FEATURE_FLAGS,
    uiStrings: BUILTIN_UI_STRINGS,
    mcpServers: BUILTIN_MCP_SERVERS,
    entitlement: BUILTIN_ENTITLEMENT,
    killSwitches: BUILTIN_KILL_SWITCHES,
    release: BUILTIN_RELEASE_POLICY,
  };
}

// 导出内置版本号
export const BUILTIN_CONFIG_VERSION = BUILTIN_VERSION;
