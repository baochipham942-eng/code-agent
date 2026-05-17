// ============================================================================
// MCP Default Servers - 默认服务器配置 + 云端配置转换 + 初始化/刷新
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getCloudConfigService, type MCPServerCloudConfig } from '../services/cloud/cloudConfigService';
import { getConfigService } from '../services/core/configService';
import type {
  MCPServerConfig,
  MCPStdioServerConfig,
  MCPSSEServerConfig,
  MCPHttpStreamableServerConfig,
} from './types';
import { createMemoryKVServer } from './servers/memoryKVServer';
import { createCodeIndexServer } from './servers/codeIndexServer';
import { loadMcpConfigFiles } from './mcpConfigFile';
import type { MCPClient } from './mcpClient';

const logger = createLogger('MCPDefaultServers');
const DEEPWIKI_LEGACY_SSE_URL = 'https://mcp.deepwiki.com/sse';
const DEEPWIKI_STREAMABLE_HTTP_URL = 'https://mcp.deepwiki.com/mcp';

// ----------------------------------------------------------------------------
// Default MCP Server Configurations
// ----------------------------------------------------------------------------

/**
 * Get default MCP server configurations
 * Uses configService for API keys (secure storage > env variable)
 */
export function getDefaultMCPServers(): MCPServerConfig[] {
  const configService = getConfigService();
  const braveApiKey = configService?.getServiceApiKey('brave') || process.env.BRAVE_API_KEY || '';
  const githubToken = configService?.getServiceApiKey('github') || process.env.GITHUB_TOKEN || '';
  const argusEnabled = process.env.CODE_AGENT_ENABLE_ARGUS_MCP === '1';

  return [
    // ========== SSE 远程服务器 ==========

    // DeepWiki - 解读 GitHub 项目文档 (官方免费服务)
    // 工具: read_wiki_structure, read_wiki_contents, ask_question
    // 注意: /sse 端点已废弃，使用 /mcp (Streamable HTTP)
    {
      name: 'deepwiki',
      type: 'http-streamable',
      serverUrl: 'https://mcp.deepwiki.com/mcp',
      enabled: true,
    },

    // ========== Stdio 本地服务器 ==========

    // 文件系统服务器 - 核心能力
    {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', process.env.HOME || '/'],
      enabled: false, // 默认禁用，避免与内置工具冲突
    },
    // Git 服务器 - 版本控制
    {
      name: 'git',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git'],
      enabled: false, // 默认禁用，可在设置中启用
    },
    // GitHub 服务器
    {
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      },
      enabled: !!githubToken,
    },
    // SQLite 服务器
    {
      name: 'sqlite',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite'],
      enabled: false,
    },
    // Brave Search 服务器
    {
      name: 'brave-search',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: {
        BRAVE_API_KEY: braveApiKey,
      },
      enabled: !!braveApiKey,
    },
    // Memory 服务器 - 知识图谱记忆
    {
      name: 'memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      enabled: false, // 默认禁用，可在设置中启用
    },

    // ========== Phase 1: Sequential Thinking ==========
    // Sequential Thinking 服务器 - 动态问题分解和逐步推理
    {
      name: 'sequential-thinking',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: true, // 默认启用，提升复杂任务处理能力
    },

    // ========== Phase 3: Puppeteer ==========
    // Puppeteer 服务器 - 浏览器自动化
    {
      name: 'puppeteer',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      enabled: false, // 默认禁用，需要时启用
    },

    // ========== Phase 3: Docker ==========
    // Docker 服务器 - 容器管理
    {
      name: 'docker',
      command: 'npx',
      args: ['-y', 'mcp-server-docker'],
      enabled: false, // 默认禁用，需要 Docker 环境
    },

    // ========== Phase 4: Argus Computer Use ==========
    // 桌面自动化 — 24 工具 (截图/点击/输入/batch)，无安全限制版
    // 基于 Anthropic Chicago MCP 架构，使用 OSS 原生层 (screencapture + cliclick)
    {
      name: 'argus',
      command: 'node',
      args: [
        `${process.env.HOME}/Downloads/ai/argus-automation/dist/server-mcp.js`,
      ],
      enabled: argusEnabled,
    },
  ];
}

// Legacy export for backward compatibility
export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [];

// ----------------------------------------------------------------------------
// Cloud Config to Internal Config Conversion
// ----------------------------------------------------------------------------

/**
 * 将云端 MCP 配置转换为内部配置格式
 * 支持环境变量替换（如 ${GITHUB_TOKEN}）
 */
export function convertCloudConfigToInternal(cloudConfig: MCPServerCloudConfig): MCPServerConfig {
  const { id, name, type, enabled, config, requiredEnvVars } = cloudConfig;
  const serverUrl = normalizeCloudMcpServerUrl(id, name, config.url);
  const serverType = serverUrl === DEEPWIKI_STREAMABLE_HTTP_URL && config.url === DEEPWIKI_LEGACY_SSE_URL
    ? 'http-streamable'
    : type;

  // 检查必需的环境变量
  let shouldEnable = enabled;
  if (requiredEnvVars && requiredEnvVars.length > 0) {
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      logger.debug(`MCP server ${name} disabled: missing env vars: ${missingVars.join(', ')}`);
      shouldEnable = false;
    }
  }

  // 替换环境变量占位符
  const resolveEnvVars = (obj: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!obj) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      // 替换 ${VAR_NAME} 格式
      result[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] || '');
    }
    return result;
  };

  if (serverType === 'http-streamable') {
    return {
      name: id,
      type: 'http-streamable',
      serverUrl: serverUrl!,
      headers: resolveEnvVars(config.headers),
      enabled: shouldEnable,
      requiredEnvVars,
    } as MCPHttpStreamableServerConfig;
  } else if (serverType === 'sse') {
    return {
      name: id,
      type: 'sse',
      serverUrl: serverUrl!,
      headers: resolveEnvVars(config.headers),
      enabled: shouldEnable,
    } as MCPSSEServerConfig;
  } else {
    return {
      name: id,
      command: config.command!,
      args: config.args?.map(arg =>
        arg === '~' ? (process.env.HOME || '/') : arg
      ),
      env: resolveEnvVars(config.env),
      enabled: shouldEnable,
    } as MCPStdioServerConfig;
  }
}

function normalizeCloudMcpServerUrl(id: string, name: string, url: string | undefined): string | undefined {
  const normalizedId = id.trim().toLowerCase();
  const normalizedName = name.trim().toLowerCase();
  if (
    url === DEEPWIKI_LEGACY_SSE_URL
    && (normalizedId === 'deepwiki' || normalizedName.includes('deepwiki'))
  ) {
    logger.warn('Rewriting deprecated DeepWiki MCP SSE endpoint to streamable HTTP');
    return DEEPWIKI_STREAMABLE_HTTP_URL;
  }
  return url;
}

// ----------------------------------------------------------------------------
// Initialization and Refresh
// ----------------------------------------------------------------------------

/**
 * 初始化 MCP 客户端
 *
 * 配置来源优先级（同名后者覆盖前者）：
 *   内置默认 / 云端 < user .mcp.json < project .mcp.json < local .mcp.json < runtime
 *
 * @param workingDirectory 当前项目目录，用于定位 project / local scope 的 .mcp.json
 */
export async function initMCPClient(
  getMCPClientFn: () => MCPClient,
  customConfigs?: MCPServerConfig[],
  workingDirectory?: string,
): Promise<MCPClient> {
  const client = getMCPClientFn();

  // 从云端配置服务获取 MCP 配置
  const cloudConfigService = getCloudConfigService();
  const configuredCloudMCPServers = cloudConfigService.getMCPServers();
  const cloudMCPServersAllowed = cloudConfigService.isCloudMCPServersEnabledByPolicy();
  const cloudMCPServers = cloudMCPServersAllowed ? configuredCloudMCPServers : [];

  if (cloudMCPServers.length > 0) {
    logger.info(`Loading ${cloudMCPServers.length} MCP servers from cloud config`);
    for (const cloudConfig of cloudMCPServers) {
      const internalConfig = convertCloudConfigToInternal(cloudConfig);
      internalConfig.scope = 'cloud';
      client.addServer(internalConfig);
    }
  } else if (configuredCloudMCPServers.length > 0) {
    logger.warn('Cloud MCP servers blocked by control-plane policy', {
      reason: cloudConfigService.getCloudMCPServerPolicyBlockReason(),
      count: configuredCloudMCPServers.length,
    });
  } else {
    logger.warn('No MCP servers in cloud config, using default servers');
    const defaultServers = getDefaultMCPServers();
    for (const config of defaultServers) {
      config.scope = 'builtin';
      client.addServer(config);
    }
  }

  // .mcp.json 配置文件：user → project → local 三档 scope
  try {
    const fileConfigs = await loadMcpConfigFiles(workingDirectory);
    if (fileConfigs.length > 0) {
      logger.info(`Loading ${fileConfigs.length} MCP servers from .mcp.json config files`);
      for (const config of fileConfigs) {
        client.addServer(config);
      }
    }
  } catch (error) {
    logger.error('Failed to load .mcp.json config files (non-blocking):', error);
  }

  // 添加自定义配置（运行时来源，优先级最高）
  if (customConfigs) {
    for (const config of customConfigs) {
      client.addServer({ ...config, scope: 'runtime' });
    }
  }

  // 注册内置的 In-Process 服务器
  try {
    logger.info('Registering built-in in-process MCP servers...');

    // Memory KV Server - 简单的键值存储
    const memoryKVServer = createMemoryKVServer();
    await client.registerInProcessServer(memoryKVServer);

    // Code Index Server - 代码索引和符号查找
    const codeIndexServer = createCodeIndexServer();
    await client.registerInProcessServer(codeIndexServer);

    logger.info('Built-in in-process MCP servers registered');
  } catch (error) {
    logger.error('Failed to register in-process servers:', error);
    // 不阻止其他服务器连接
  }

  // 连接到所有启用的服务器
  await client.connectAll();

  return client;
}

/**
 * 从云端配置刷新 MCP 服务器
 * 用于热更新场景
 */
export async function refreshMCPServersFromCloud(
  getMCPClientFn: () => MCPClient,
): Promise<void> {
  const client = getMCPClientFn();
  const cloudConfigService = getCloudConfigService();

  // 刷新云端配置
  await cloudConfigService.refresh();
  const configuredCloudMCPServers = cloudConfigService.getMCPServers();
  const cloudMCPServersAllowed = cloudConfigService.isCloudMCPServersEnabledByPolicy();
  const cloudMCPServers = cloudMCPServersAllowed ? configuredCloudMCPServers : [];

  if (!cloudMCPServersAllowed && configuredCloudMCPServers.length > 0) {
    logger.warn('Cloud MCP servers blocked during refresh by control-plane policy', {
      reason: cloudConfigService.getCloudMCPServerPolicyBlockReason(),
      count: configuredCloudMCPServers.length,
    });
  }

  logger.info(`Refreshing MCP servers from cloud config: ${cloudMCPServers.length} servers`);

  // 获取当前配置的服务器名称
  const currentStates = client.getServerStates();
  const currentServerNames = new Set(
    currentStates
      .filter(s => s.config.scope === 'cloud')
      .map(s => s.config.name),
  );
  const newServerNames = new Set(cloudMCPServers.map(s => s.id));

  // 移除云端已删除的服务器
  for (const name of currentServerNames) {
    if (!newServerNames.has(name)) {
      await client.removeServer(name);
    }
  }

  // 添加或更新服务器
  for (const cloudConfig of cloudMCPServers) {
    const internalConfig = convertCloudConfigToInternal(cloudConfig);
    internalConfig.scope = 'cloud';
    const existingState = client.getServerState(cloudConfig.id);
    if (existingState && existingState.config.scope !== 'cloud') {
      logger.warn(`Skipping cloud MCP server ${cloudConfig.id}: non-cloud config with same name exists`, {
        existingScope: existingState.config.scope,
      });
      continue;
    }

    if (currentServerNames.has(cloudConfig.id)) {
      // 更新现有配置
      await client.updateServerConfig(cloudConfig.id, internalConfig);
    } else {
      // 添加新服务器
      client.addServer(internalConfig);
      if (internalConfig.enabled) {
        try {
          await client.connect(internalConfig);
        } catch (error) {
          logger.error(`Failed to connect to new MCP server ${cloudConfig.id}:`, error);
        }
      }
    }
  }
}
