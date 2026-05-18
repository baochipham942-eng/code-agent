// ============================================================================
// CapabilityCenterService
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  CapabilityActionInfo,
  CapabilityCenterInventory,
  CapabilityCenterItem,
  CapabilityCenterSummary,
  CapabilityKind,
  CapabilityPermission,
  CapabilityRequirement,
  CapabilityRiskInfo,
  CapabilityRuntimeState,
  CapabilitySourceKind,
  CapabilityStateInfo,
  CapabilityInstallDraftRequest,
  CapabilityRemoveDraftRequest,
  CapabilityToggleRequest,
  CapabilityCenterDiagnostic,
} from '../../../shared/contract/capability';
import type { ParsedSkill, SkillSource } from '../../../shared/contract/agentSkill';
import type {
  ChannelAccount,
  ChannelAccountConfig,
  ChannelType,
  FeishuChannelConfig,
  HttpApiChannelConfig,
  TelegramChannelConfig,
} from '../../../shared/contract/channel';
import { NATIVE_CONNECTOR_IDS, type NativeConnectorId } from '../../../shared/constants';
import { getChannelManager } from '../../channels';
import { getConnectorRegistry } from '../../connectors';
import { getContextHealthService } from '../../context/contextHealthService';
import { getMemoryDir } from '../../lightMemory/indexLoader';
import {
  getMCPClient,
  isHttpStreamableConfig,
  isInProcessConfig,
  isSSEConfig,
  isStdioConfig,
  type MCPServerConfig,
  type MCPServerState,
} from '../../mcp/mcpClient';
import type { ConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';
import { getSkillDiscoveryService } from '../skills/skillDiscoveryService';
import { getSkillRepositoryService } from '../skills/skillRepositoryService';
import { CORE_TOOLS, DEFERRED_TOOLS_META } from '../toolSearch/deferredTools';
import { readCuratedRegistry } from './curatedCapabilityRegistry';
import {
  normalizeMcpSettingsServerConfig,
  persistMcpSettingsServerConfig,
  removeMcpSettingsServerDraftConfig,
} from '../../ipc/mcp.ipc';
import { resolveInstallDraftConfig } from './capabilityDraftResolver';
import { getAgentEngineRegistry } from '../agentEngine';
import { buildAgentEngineCapabilityItem } from './agentEngineCapabilityItems';
import { getRemoteCapabilityRegistryService } from './remoteCapabilityRegistryService';

const logger = createLogger('CapabilityCenterService');

const NATIVE_CONNECTOR_LABELS: Record<NativeConnectorId, string> = {
  calendar: 'Calendar',
  mail: 'Mail',
  reminders: 'Reminders',
  photos: 'Photos',
};

const CAPABILITY_KIND_ORDER: Record<CapabilityKind, number> = {
  agent_engine: 0,
  skill: 1,
  mcp_template: 2,
  tool_bundle: 3,
  connector: 4,
  channel_adapter: 5,
  workflow_recipe: 6,
};

const TOOL_BUNDLES = [
  {
    id: 'core-tools',
    name: '核心工具包',
    summary: '每轮默认进入模型的文件、搜索、规划、记忆和 Skill 元工具。',
    tags: ['tool', 'core', 'permission'],
    toolNames: CORE_TOOLS,
    risk: 'high' as const,
    reasons: ['包含文件写入、shell、记忆写入等高影响工具'],
  },
  {
    id: 'deferred-tools',
    name: '延迟工具目录',
    summary: '通过 ToolSearch 按需加载的浏览器、文档、桌面、规划和扩展工具。',
    tags: ['tool', 'tool-search', 'lazy'],
    toolNames: DEFERRED_TOOLS_META.map((tool) => tool.name),
    risk: 'medium' as const,
    reasons: ['只有命中后才加载，但工具面覆盖网络、本地桌面和外部系统'],
  },
  {
    id: 'browser-computer',
    name: '浏览器与桌面自动化',
    summary: '浏览器导航、点击、截图、桌面上下文和计算机控制能力。',
    tags: ['browser', 'desktop', 'vision'],
    toolNames: DEFERRED_TOOLS_META
      .filter((tool) => {
        const source = [tool.name, tool.shortDescription, ...tool.tags, ...tool.aliases].join(' ').toLowerCase();
        return source.includes('browser') || source.includes('computer') || source.includes('desktop');
      })
      .map((tool) => tool.name),
    risk: 'high' as const,
    reasons: ['可能读取屏幕、操作浏览器或控制本机输入'],
  },
  {
    id: 'document-office',
    name: '文档与办公数据',
    summary: '读取 PDF、Word、Excel，以及本地 Calendar/Mail/Reminders 连接器相关工具。',
    tags: ['document', 'office', 'connector'],
    toolNames: [
      ...DEFERRED_TOOLS_META
        .filter((tool) => {
          const source = [tool.name, tool.shortDescription, ...tool.tags, ...tool.aliases].join(' ').toLowerCase();
          return source.includes('document') || source.includes('pdf') || source.includes('excel') || source.includes('mail') || source.includes('calendar');
        })
        .map((tool) => tool.name),
    ],
    risk: 'medium' as const,
    reasons: ['可能读取本地文档、邮件、日历或提醒事项'],
  },
  {
    id: 'planning-agent-team',
    name: '规划与 Agent Team',
    summary: '任务管理、计划、子代理探索和多 agent 协作相关工具。',
    tags: ['planning', 'multiagent', 'team'],
    toolNames: ['Task', 'Explore', 'TaskManager', 'Plan', 'PlanMode'],
    risk: 'medium' as const,
    reasons: ['会启动子代理或改变任务编排，但仍走现有工具权限模型'],
  },
];

export interface CapabilityListOptions {
  workingDirectory?: string;
  configService?: ConfigService | null;
  remoteCapabilityRegistryService?: CapabilityRegistryReader | null;
}

export interface CapabilityToggleOptions {
  workingDirectory?: string;
  configService?: ConfigService | null;
}

export type CapabilityInstallDraftOptions = CapabilityListOptions;

export interface CapabilityRegistryReader {
  readRegistry: () => Promise<{
    items: CapabilityCenterItem[];
    diagnostics: CapabilityCenterDiagnostic[];
  }>;
}

function encodeCapabilityId(prefix: string, rawId: string): string {
  return `${prefix}:${encodeURIComponent(rawId)}`;
}

function decodeCapabilityId(id: string, prefix: string): string {
  const fullPrefix = `${prefix}:`;
  if (!id.startsWith(fullPrefix)) {
    throw new Error(`Capability id ${id} does not match ${prefix}`);
  }
  return decodeURIComponent(id.slice(fullPrefix.length));
}

function unique(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function sourceKindFromSkillSource(source: SkillSource): CapabilitySourceKind {
  return source;
}

function sourceLabel(kind: CapabilitySourceKind): string {
  switch (kind) {
    case 'builtin':
      return '内置';
    case 'cloud':
      return '云端配置';
    case 'project':
      return '项目';
    case 'user':
      return '用户目录';
    case 'library':
      return '本地 Skill 库';
    case 'memory':
      return 'Light Memory';
    case 'runtime':
      return '运行时';
    case 'curated':
      return '本地 curated registry';
    case 'marketplace':
      return 'Marketplace';
    case 'team':
      return '团队 registry';
    case 'remote':
      return '远程来源';
    case 'plugin':
      return '插件';
    default:
      return '本地';
  }
}

function buildAction(canToggle: boolean, reason?: string): CapabilityActionInfo {
  return {
    canEnable: canToggle,
    canDisable: canToggle,
    ...(reason ? { reason } : {}),
  };
}

function buildState(args: {
  install?: CapabilityStateInfo['install'];
  enable?: CapabilityStateInfo['enable'];
  runtime?: CapabilityRuntimeState;
  statusLabel?: string;
  error?: string;
}): CapabilityStateInfo {
  return {
    install: args.install ?? 'installed',
    enable: args.enable ?? 'enabled',
    runtime: args.runtime ?? 'ready',
    mount: 'not_applicable',
    ...(args.statusLabel ? { statusLabel: args.statusLabel } : {}),
    ...(args.error ? { error: args.error } : {}),
  };
}

function buildRisk(tier: CapabilityRiskInfo['tier'], reasons: string[], dataTouched?: string[]): CapabilityRiskInfo {
  return {
    tier,
    reasons,
    ...(dataTouched?.length ? { dataTouched } : {}),
  };
}

function permission(label: string, level: CapabilityPermission['level'], detail?: string): CapabilityPermission {
  return {
    label,
    level,
    ...(detail ? { detail } : {}),
  };
}

function requirement(
  kind: CapabilityRequirement['kind'],
  label: string,
  status: CapabilityRequirement['status'],
  value?: string,
  sensitive = false,
): CapabilityRequirement {
  return {
    kind,
    label,
    status,
    ...(value ? { value } : {}),
    ...(sensitive ? { sensitive } : {}),
  };
}

function riskFromAllowedTools(allowedTools: string[]): CapabilityRiskInfo {
  const joined = allowedTools.join(' ').toLowerCase();
  if (/(bash|write|edit|computer|mcp|desktop|browser)/.test(joined)) {
    return buildRisk('high', ['声明了可触达本地文件、shell、桌面、浏览器或 MCP 的工具权限']);
  }
  if (/(web|fetch|search|read)/.test(joined)) {
    return buildRisk('medium', ['声明了网络或读取类工具权限']);
  }
  return buildRisk('low', ['只声明低影响或未声明额外工具权限']);
}

function buildSkillDependencies(skill: ParsedSkill): CapabilityRequirement[] {
  const deps: CapabilityRequirement[] = [];
  for (const bin of skill.bins || []) {
    const missing = skill.dependencyStatus?.missingBins.includes(bin);
    deps.push(requirement('binary', bin, missing ? 'missing' : 'unknown'));
  }
  for (const envVar of skill.envVars || []) {
    const missing = skill.dependencyStatus?.missingEnvVars.includes(envVar);
    deps.push(requirement('env', envVar, missing ? 'missing' : (process.env[envVar] ? 'met' : 'unknown'), undefined, true));
  }
  for (const reference of skill.references || []) {
    const missing = skill.dependencyStatus?.missingReferences.includes(reference);
    deps.push(requirement('path', reference, missing ? 'missing' : 'unknown'));
  }
  return deps;
}

function skillRuntimeState(skill: ParsedSkill): CapabilityRuntimeState {
  if (skill.dependencyStatus && !skill.dependencyStatus.satisfied) {
    return 'blocked';
  }
  return 'ready';
}

function buildMcpConfigRequirements(config: MCPServerConfig): CapabilityRequirement[] {
  const requirements: CapabilityRequirement[] = [];

  if (isStdioConfig(config)) {
    requirements.push(requirement('binary', config.command, 'unknown', config.command));
    for (const [key, value] of Object.entries(config.env || {})) {
      requirements.push(requirement('env', key, hasValue(value) || hasValue(process.env[key]) ? 'met' : 'missing', undefined, true));
    }
    return requirements;
  }

  if (isSSEConfig(config) || isHttpStreamableConfig(config)) {
    requirements.push(requirement('network', config.serverUrl, hasValue(config.serverUrl) ? 'met' : 'missing', config.serverUrl));
    for (const [key, value] of Object.entries(config.headers || {})) {
      requirements.push(requirement('secret', key, hasValue(value) ? 'met' : 'missing', undefined, true));
    }
    if (isHttpStreamableConfig(config)) {
      for (const envVar of config.requiredEnvVars || []) {
        requirements.push(requirement('env', envVar, process.env[envVar] ? 'met' : 'missing', undefined, true));
      }
    }
  }

  return requirements;
}

function buildMcpRisk(config: MCPServerConfig): CapabilityRiskInfo {
  if (isStdioConfig(config)) {
    return buildRisk('high', ['stdio MCP 会启动本地命令'], ['本地进程', 'MCP 工具输入输出']);
  }
  if (isSSEConfig(config) || isHttpStreamableConfig(config)) {
    return buildRisk('high', ['远程 MCP 会连接外部服务'], ['网络请求', 'MCP 工具输入输出']);
  }
  if (isInProcessConfig(config)) {
    return buildRisk('medium', ['进程内 MCP 仍可能暴露本地工具能力']);
  }
  return buildRisk('medium', ['MCP 工具权限取决于 server 声明和运行时审批']);
}

function mcpRuntimeState(state: MCPServerState): CapabilityRuntimeState {
  switch (state.status) {
    case 'connected':
      return 'connected';
    case 'lazy':
      return 'lazy';
    case 'error':
      return 'error';
    case 'disconnected':
      return state.config.enabled ? 'disconnected' : 'not_configured';
    case 'connecting':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function buildChannelConfigRequirements(config: ChannelAccountConfig): CapabilityRequirement[] {
  switch (config.type) {
    case 'http-api': {
      const httpConfig = config as HttpApiChannelConfig;
      return [
        requirement('config', 'port', hasValue(httpConfig.port) ? 'met' : 'missing', String(httpConfig.port || '')),
        requirement('secret', 'apiKey', hasValue(httpConfig.apiKey) ? 'met' : 'missing', undefined, true),
        requirement('config', 'privacyMode', hasValue(httpConfig.privacyMode) ? 'met' : 'unknown', httpConfig.privacyMode),
      ];
    }
    case 'feishu': {
      const feishuConfig = config as FeishuChannelConfig;
      return [
        requirement('secret', 'appId', hasValue(feishuConfig.appId) ? 'met' : 'missing', undefined, true),
        requirement('secret', 'appSecret', hasValue(feishuConfig.appSecret) ? 'met' : 'missing', undefined, true),
        requirement('config', 'webhookPort', hasValue(feishuConfig.webhookPort) ? 'met' : 'unknown', String(feishuConfig.webhookPort || '')),
        requirement('config', 'privacyMode', hasValue(feishuConfig.privacyMode) ? 'met' : 'unknown', feishuConfig.privacyMode),
      ];
    }
    case 'telegram': {
      const telegramConfig = config as TelegramChannelConfig;
      return [
        requirement('secret', 'botToken', hasValue(telegramConfig.botToken) ? 'met' : 'missing', undefined, true),
        requirement('config', 'allowedUserIds', telegramConfig.allowedUserIds?.length ? 'met' : 'unknown'),
        requirement('config', 'privacyMode', hasValue(telegramConfig.privacyMode) ? 'met' : 'unknown', telegramConfig.privacyMode),
      ];
    }
    default:
      return [];
  }
}

function channelRuntimeState(account: ChannelAccount): CapabilityRuntimeState {
  if (!account.enabled) {
    return 'not_configured';
  }
  switch (account.status) {
    case 'connected':
      return 'connected';
    case 'error':
      return 'error';
    case 'connecting':
      return 'unknown';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'unknown';
  }
}

function parseMemoryRecipe(content: string): { name: string; description: string } | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return null;
  const frontmatter = content.slice(3, end).trim();
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (fields.type !== 'skill' || !fields.name) return null;
  return {
    name: fields.name,
    description: fields.description || 'Light Memory procedural recipe',
  };
}

async function readWorkflowRecipes(): Promise<CapabilityCenterItem[]> {
  const dir = getMemoryDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('Failed to read memory recipes', { error });
    }
    return [];
  }

  const items: CapabilityCenterItem[] = [];
  for (const filename of entries.filter((entry) => entry.startsWith('skill_') && entry.endsWith('.md'))) {
    const fullPath = path.join(dir, filename);
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const recipe = parseMemoryRecipe(content);
      if (!recipe) continue;
      items.push({
        id: encodeCapabilityId('workflow', filename),
        kind: 'workflow_recipe',
        name: recipe.name,
        summary: recipe.description,
        tags: ['workflow', 'memory', 'recipe'],
        source: {
          kind: 'memory',
          label: sourceLabel('memory'),
          path: fullPath,
        },
        state: buildState({ runtime: 'lazy' }),
        risk: buildRisk('low', ['只作为相关流程记忆注入，不直接扩大工具权限']),
        permissions: [permission('Prompt injection only', 'low', '按查询相关性进入 dynamic system section')],
        config: [],
        dependencies: [],
        audit: {
          installedFiles: [fullPath],
        },
        actions: buildAction(false, 'Light Memory workflow 目前按相关性加载，没有独立启停开关'),
      });
    } catch (error) {
      logger.debug('Skipping unreadable workflow recipe', { filename, error });
    }
  }
  return items;
}

function summarize(items: CapabilityCenterItem[]): CapabilityCenterSummary {
  return {
    total: items.length,
    installed: items.filter((item) => item.state.install === 'installed' || item.state.install === 'not_applicable').length,
    enabled: items.filter((item) => item.state.enable === 'enabled').length,
    blocked: items.filter((item) => item.state.runtime === 'blocked' || item.state.runtime === 'error').length,
    highRisk: items.filter((item) => item.risk.tier === 'high').length,
  };
}

class CapabilityCenterService {
  async listCapabilities(options: CapabilityListOptions = {}): Promise<CapabilityCenterInventory> {
    const [curatedRegistry, remoteRegistry] = await Promise.all([
      readCuratedRegistry(options.workingDirectory),
      this.readRemoteCapabilityRegistry(options),
    ]);
    const registryItems = this.applyDraftState([
      ...curatedRegistry.items,
      ...remoteRegistry.items,
    ]);
    const items = [
      ...await this.listAgentEngines(),
      ...await this.listSkills(options.workingDirectory),
      ...this.listMcpServers(),
      ...this.listToolBundles(),
      ...await this.listConnectors(options.configService),
      ...this.listChannels(),
      ...await readWorkflowRecipes(),
      ...registryItems,
    ].sort((left, right) => {
      const byKind = CAPABILITY_KIND_ORDER[left.kind] - CAPABILITY_KIND_ORDER[right.kind];
      if (byKind !== 0) return byKind;
      return left.name.localeCompare(right.name);
    });

    return {
      generatedAt: Date.now(),
      summary: summarize(items),
      items,
      diagnostics: [
        ...curatedRegistry.diagnostics,
        ...remoteRegistry.diagnostics,
      ],
    };
  }

  private async readRemoteCapabilityRegistry(
    options: CapabilityListOptions,
  ): Promise<{ items: CapabilityCenterItem[]; diagnostics: CapabilityCenterDiagnostic[] }> {
    if (options.remoteCapabilityRegistryService === null) {
      return { items: [], diagnostics: [] };
    }
    try {
      return await (options.remoteCapabilityRegistryService || getRemoteCapabilityRegistryService()).readRegistry();
    } catch (error) {
      logger.warn('Failed to read remote capability registry', { error: String(error) });
      return { items: [], diagnostics: [] };
    }
  }

  private async listAgentEngines(): Promise<CapabilityCenterItem[]> {
    const descriptors = await getAgentEngineRegistry().list();
    return descriptors.map(buildAgentEngineCapabilityItem);
  }

  async setEnabled(request: CapabilityToggleRequest, options: CapabilityToggleOptions = {}): Promise<CapabilityCenterInventory> {
    const currentInventory = await this.listCapabilities(options);
    const currentItem = currentInventory.items.find((item) => item.id === request.id && item.kind === request.kind);
    if (!currentItem) {
      throw new Error(`Capability not found: ${request.kind}:${request.id}`);
    }

    const allowed = request.enabled
      ? currentItem.actions.canEnable
      : currentItem.actions.canDisable;
    if (!allowed) {
      throw new Error(currentItem.actions.reason || `Capability ${request.id} cannot be toggled`);
    }

    switch (request.kind) {
      case 'skill':
        await this.setSkillEnabled(request.id, request.enabled);
        break;
      case 'mcp_template':
        await this.setMcpEnabled(request.id, request.enabled);
        break;
      case 'connector':
        await this.setConnectorEnabled(request.id, request.enabled, options.configService);
        break;
      case 'channel_adapter':
        await this.setChannelAccountEnabled(request.id, request.enabled);
        break;
      default:
        throw new Error(`Capability kind ${request.kind} cannot be toggled from Capability Center`);
    }

    return this.listCapabilities(options);
  }

  async installDraft(
    request: CapabilityInstallDraftRequest,
    options: CapabilityInstallDraftOptions = {},
  ): Promise<CapabilityCenterInventory> {
    if (!options.workingDirectory) {
      throw new Error('Working directory is required to generate capability drafts');
    }

    const currentInventory = await this.listCapabilities(options);
    const currentItem = currentInventory.items.find((item) => item.id === request.id && item.kind === request.kind);
    if (!currentItem) {
      throw new Error(`Capability not found: ${request.kind}:${request.id}`);
    }

    const draft = currentItem.installPlan?.draft;
    if (!currentItem.actions.canInstallDraft || !draft) {
      throw new Error(currentItem.actions.reason || `Capability ${request.id} cannot generate a draft`);
    }

    switch (draft.kind) {
      case 'mcp_server': {
        const serverConfig = normalizeMcpSettingsServerConfig(
          resolveInstallDraftConfig(draft, request.inputs),
        );
        const existing = getMCPClient().getServerState(serverConfig.name);
        if (existing) {
          throw new Error(`MCP server "${serverConfig.name}" already exists`);
        }
        const draftServerConfig: MCPServerConfig = {
          ...serverConfig,
          capabilityDraft: {
            origin: 'capability_center',
            capabilityId: request.id,
            capabilityKind: 'mcp_template',
            installedAt: Date.now(),
          },
        };
        await persistMcpSettingsServerConfig(options.workingDirectory, draftServerConfig);
        getMCPClient().addServer({ ...draftServerConfig, scope: 'project' });
        break;
      }
      default:
        throw new Error(`Unsupported draft kind: ${(draft as { kind: string }).kind}`);
    }

    return this.listCapabilities(options);
  }

  async removeDraft(
    request: CapabilityRemoveDraftRequest,
    options: CapabilityInstallDraftOptions = {},
  ): Promise<CapabilityCenterInventory> {
    if (!options.workingDirectory) {
      throw new Error('Working directory is required to remove capability drafts');
    }

    const currentInventory = await this.listCapabilities(options);
    const currentItem = currentInventory.items.find((item) => item.id === request.id && item.kind === request.kind);
    if (!currentItem) {
      throw new Error(`Capability not found: ${request.kind}:${request.id}`);
    }
    if (!currentItem.actions.canRemoveDraft) {
      throw new Error(currentItem.actions.reason || `Capability ${request.id} does not have a removable draft`);
    }

    const draftState = this.findMcpDraftStateForCapability(request.id);
    if (!draftState) {
      throw new Error(`Capability draft not found: ${request.id}`);
    }
    if (draftState.config.enabled) {
      throw new Error(`MCP draft "${draftState.config.name}" must be disabled before removal`);
    }

    await removeMcpSettingsServerDraftConfig(
      options.workingDirectory,
      draftState.config.name,
      request.id,
    );
    await getMCPClient().removeServer(draftState.config.name);
    getContextHealthService().clearMcpServerAcrossSessions(draftState.config.name);

    return this.listCapabilities(options);
  }

  private findMcpDraftStateForCapability(capabilityId: string): MCPServerState | undefined {
    return getMCPClient().getServerStates().find((state) => {
      const draft = state.config.capabilityDraft;
      return draft?.origin === 'capability_center'
        && draft.capabilityId === capabilityId
        && state.config.enabled === false;
    });
  }

  private applyDraftState(items: CapabilityCenterItem[]): CapabilityCenterItem[] {
    return items.map((item) => {
      if (!['curated', 'remote', 'marketplace', 'team'].includes(item.source.kind) || item.kind !== 'mcp_template') {
        return item;
      }
      const draftState = this.findMcpDraftStateForCapability(item.id);
      if (!draftState) {
        return item;
      }

      const serverName = draftState.config.name;
      const configFile = draftState.config.scope
        ? `${draftState.config.scope}:mcp.json`
        : 'runtime MCP config';
      return {
        ...item,
        state: buildState({
          install: 'draft',
          enable: 'disabled',
          runtime: 'not_configured',
          statusLabel: 'draft',
        }),
        audit: {
          ...item.audit,
          configFiles: unique([...(item.audit.configFiles || []), configFile]),
          notes: [
            ...(item.audit.notes || []),
            `Draft generated as disabled MCP server "${serverName}".`,
          ],
        },
        actions: {
          canEnable: false,
          canDisable: false,
          canInstallDraft: false,
          canRemoveDraft: true,
          reason: '已生成 disabled MCP draft，可删除草稿或到 MCP 设置中管理',
        },
        relatedIds: unique([...(item.relatedIds || []), encodeCapabilityId('mcp', serverName)]),
      } satisfies CapabilityCenterItem;
    });
  }

  private async listSkills(workingDirectory?: string): Promise<CapabilityCenterItem[]> {
    const discovery = getSkillDiscoveryService();
    if (workingDirectory) {
      await discovery.ensureInitialized(workingDirectory);
    }

    const repository = getSkillRepositoryService();
    await repository.initialize();
    const localLibraryBySkill = new Map<string, { libraryId: string; enabled: boolean; version?: string; localPath?: string }>();
    for (const library of repository.getLocalLibraries()) {
      for (const skill of library.skills) {
        localLibraryBySkill.set(skill.name, {
          libraryId: library.repoId,
          enabled: skill.enabled,
          version: library.version,
          localPath: skill.localPath,
        });
      }
    }

    return discovery.getAllSkills().map((skill) => {
      const library = localLibraryBySkill.get(skill.name);
      const sourceKind = sourceKindFromSkillSource(skill.source);
      const sourcePath = library?.localPath || skill.basePath;
      const enableState = skill.source === 'library'
        ? library?.enabled ? 'enabled' : 'disabled'
        : 'enabled';
      const deps = buildSkillDependencies(skill);
      const risk = riskFromAllowedTools(skill.allowedTools);

      return {
        id: encodeCapabilityId('skill', skill.name),
        kind: 'skill',
        name: skill.name,
        summary: skill.description,
        description: skill.promptContent ? undefined : skill.description,
        tags: unique(['skill', skill.source, ...(skill.aliases || [])]),
        source: {
          kind: sourceKind,
          label: sourceLabel(sourceKind),
          path: sourcePath,
          version: library?.version,
          scope: skill.source,
        },
        state: buildState({
          install: 'installed',
          enable: enableState,
          runtime: skillRuntimeState(skill),
          statusLabel: skill.source === 'library' ? `库: ${library?.libraryId || 'unknown'}` : skill.source,
        }),
        risk,
        permissions: skill.allowedTools.length > 0
          ? skill.allowedTools.map((tool) => permission(tool, risk.tier, 'Skill frontmatter allowed-tools 声明；仍受现有运行时权限模型约束'))
          : [permission('No extra allowed-tools', 'low', '未声明额外工具权限')],
        config: [],
        dependencies: deps,
        audit: {
          installedFiles: sourcePath ? [sourcePath] : undefined,
          notes: [
            skill.source === 'library'
              ? 'library skill 可全局启停'
              : '非 library skill 目前由来源目录决定可见性',
          ],
        },
        actions: buildAction(skill.source === 'library', skill.source === 'library' ? undefined : '只有 library skill 支持全局启停'),
      } satisfies CapabilityCenterItem;
    });
  }

  private listMcpServers(): CapabilityCenterItem[] {
    const states = getMCPClient().getServerStates();
    return states.map((state) => {
      const config = state.config;
      const sourceKind = (config.scope || 'runtime') as CapabilitySourceKind;
      const transport = config.type || 'stdio';
      const risk = buildMcpRisk(config);
      const requirements = buildMcpConfigRequirements(config);

      return {
        id: encodeCapabilityId('mcp', config.name),
        kind: 'mcp_template',
        name: config.name,
        summary: `${transport} MCP server，暴露 ${state.toolCount} 个工具和 ${state.resourceCount} 个资源。`,
        tags: unique(['mcp', transport, config.scope]),
        source: {
          kind: sourceKind,
          label: sourceLabel(sourceKind),
          scope: config.scope,
        },
        state: buildState({
          install: 'installed',
          enable: config.enabled ? 'enabled' : 'disabled',
          runtime: mcpRuntimeState(state),
          statusLabel: state.status,
          error: state.error,
        }),
        risk,
        permissions: [
          permission('MCP tool annotations', 'medium', '工具级读写/破坏性提示由 MCP server 声明，运行时仍走 ToolExecutor 审批'),
          ...(isStdioConfig(config) ? [permission('Local command', 'high', config.command)] : []),
        ],
        config: requirements,
        dependencies: requirements.filter((item) => item.kind === 'binary' || item.kind === 'env'),
        audit: {
          configFiles: config.scope ? [`${config.scope}:mcp.json`] : ['runtime MCP config'],
          notes: ['Capability Center 只启停已有 MCP config，不安装远程模板'],
        },
        actions: buildAction(true),
        metrics: {
          tools: state.toolCount,
          resources: state.resourceCount,
        },
      } satisfies CapabilityCenterItem;
    });
  }

  private listToolBundles(): CapabilityCenterItem[] {
    return TOOL_BUNDLES.map((bundle) => ({
      id: encodeCapabilityId('tool-bundle', bundle.id),
      kind: 'tool_bundle',
      name: bundle.name,
      summary: bundle.summary,
      tags: bundle.tags,
      source: {
        kind: 'builtin',
        label: sourceLabel('builtin'),
      },
      state: buildState({
        install: 'not_applicable',
        enable: 'enabled',
        runtime: bundle.id === 'deferred-tools' ? 'lazy' : 'ready',
        statusLabel: `${bundle.toolNames.length} tools`,
      }),
      risk: buildRisk(bundle.risk, bundle.reasons),
      permissions: [
        permission('ToolExecutor approval', bundle.risk, '真实调用仍进入统一工具权限与审批链路'),
      ],
      config: [],
      dependencies: [],
      audit: {
        notes: ['本地内置工具包仅展示，不在 P0 提供禁用或安装动作'],
      },
      actions: buildAction(false, '内置工具包的启停需要单独的权限策略设计'),
      metrics: {
        tools: bundle.toolNames.length,
      },
    }));
  }

  private async listConnectors(configService?: ConfigService | null): Promise<CapabilityCenterItem[]> {
    const enabled = new Set(configService?.getSettings().connectors?.enabledNative ?? []);
    const statusById = new Map<string, ReturnType<ReturnType<typeof getConnectorRegistry>['list']>[number]>();
    for (const connector of getConnectorRegistry().list()) {
      statusById.set(connector.id, connector);
    }

    const items: CapabilityCenterItem[] = [];
    for (const id of NATIVE_CONNECTOR_IDS) {
      const connector = statusById.get(id);
      const status = connector ? await connector.getStatus() : null;
      const isEnabled = enabled.has(id);
      const runtime: CapabilityRuntimeState = status?.connected
        ? 'connected'
        : status?.readiness === 'failed'
          ? 'error'
          : isEnabled
            ? 'lazy'
            : 'not_configured';

      items.push({
        id: encodeCapabilityId('connector', id),
        kind: 'connector',
        name: NATIVE_CONNECTOR_LABELS[id],
        summary: `${NATIVE_CONNECTOR_LABELS[id]} native connector，用于本地系统应用数据。`,
        tags: ['connector', 'native', id],
        source: {
          kind: 'builtin',
          label: sourceLabel('builtin'),
        },
        state: buildState({
          install: 'not_applicable',
          enable: isEnabled ? 'enabled' : 'disabled',
          runtime,
          statusLabel: status?.readiness || (isEnabled ? 'enabled' : 'disabled'),
          error: status?.error,
        }),
        risk: buildRisk('medium', ['会读取或操作本机系统应用数据'], [id]),
        permissions: [
          permission('macOS app permission', 'medium', '需要本地应用登录和系统授权，授权修复仍走 connector IPC'),
        ],
        config: [
          requirement('account', `${NATIVE_CONNECTOR_LABELS[id]} app`, status?.readiness === 'ready' ? 'met' : isEnabled ? 'unknown' : 'not_applicable'),
        ],
        dependencies: [],
        audit: {
          notes: ['启停只更新 connectors.enabledNative，并复用 ConnectorRegistry configure'],
        },
        actions: buildAction(Boolean(configService)),
      });
    }
    return items;
  }

  private listChannels(): CapabilityCenterItem[] {
    const manager = getChannelManager();
    const plugins = manager.getRegisteredPlugins();
    const accounts = manager.getAccounts();
    const accountsByType = new Map<ChannelType, ChannelAccount[]>();
    for (const account of accounts) {
      const existing = accountsByType.get(account.type) || [];
      existing.push(account);
      accountsByType.set(account.type, existing);
    }

    const items: CapabilityCenterItem[] = [];
    for (const plugin of plugins) {
      const typeAccounts = accountsByType.get(plugin.type) || [];
      if (typeAccounts.length === 0) {
        items.push({
          id: encodeCapabilityId('channel-template', plugin.type),
          kind: 'channel_adapter',
          name: plugin.meta.name,
          summary: plugin.meta.description || `${plugin.type} channel adapter`,
          tags: ['channel', plugin.type, 'template'],
          source: {
            kind: 'builtin',
            label: sourceLabel('builtin'),
          },
          state: buildState({
            install: 'available',
            enable: 'not_applicable',
            runtime: 'not_configured',
            statusLabel: '未配置账号',
          }),
          risk: buildRisk('medium', ['通道会接收外部消息并触发 agent 处理']),
          permissions: [permission('External ingress', 'medium', '新增账号需在 Channels 设置中配置 secret 和隐私策略')],
          config: [],
          dependencies: [],
          audit: {
            notes: ['P0 展示内置 adapter 模板，不安装第三方 channel adapter'],
          },
          actions: buildAction(false, '请在 Channels 设置中添加账号'),
        });
        continue;
      }

      for (const account of typeAccounts) {
        items.push(this.buildChannelAccountItem(account, plugin.meta.name, plugin.meta.description));
      }
    }
    return items;
  }

  private buildChannelAccountItem(
    account: ChannelAccount,
    typeName: string,
    typeDescription?: string,
  ): CapabilityCenterItem {
    return {
      id: encodeCapabilityId('channel', account.id),
      kind: 'channel_adapter',
      name: `${account.name} (${typeName})`,
      summary: typeDescription || `${account.type} channel account`,
      tags: ['channel', account.type, account.status],
      source: {
        kind: 'builtin',
        label: sourceLabel('builtin'),
      },
      state: buildState({
        install: 'installed',
        enable: account.enabled ? 'enabled' : 'disabled',
        runtime: channelRuntimeState(account),
        statusLabel: account.status,
        error: account.errorMessage,
      }),
      risk: buildRisk('high', ['通道账号保存 secret，并可能把外部消息送入 Agent'], ['外部消息', '账号 secret']),
      permissions: [
        permission('External ingress', 'high', '接收外部平台消息'),
        permission('Secret storage', 'high', '账号配置保存在 secure storage'),
      ],
      config: buildChannelConfigRequirements(account.config),
      dependencies: [],
      audit: {
        notes: ['启停只更新已存在 channel account，不新增第三方 adapter'],
      },
      actions: buildAction(true),
      metrics: {
        accounts: 1,
        enabledAccounts: account.enabled ? 1 : 0,
      },
    };
  }

  private async setSkillEnabled(id: string, enabled: boolean): Promise<void> {
    const skillName = decodeCapabilityId(id, 'skill');
    const repository = getSkillRepositoryService();
    await repository.initialize();
    if (enabled) {
      repository.enableSkill(skillName);
    } else {
      repository.disableSkill(skillName);
    }
    await getSkillDiscoveryService().refreshLibraries();
  }

  private async setMcpEnabled(id: string, enabled: boolean): Promise<void> {
    const serverName = decodeCapabilityId(id, 'mcp');
    await getMCPClient().setServerEnabled(serverName, enabled);
    if (!enabled) {
      getContextHealthService().clearMcpServerAcrossSessions(serverName);
    }
  }

  private async setConnectorEnabled(
    id: string,
    enabled: boolean,
    configService?: ConfigService | null,
  ): Promise<void> {
    if (!configService) {
      throw new Error('Config service not initialized');
    }
    const connectorId = decodeCapabilityId(id, 'connector');
    if (!(NATIVE_CONNECTOR_IDS as readonly string[]).includes(connectorId)) {
      throw new Error(`Unknown connector: ${connectorId}`);
    }

    const current = new Set(configService.getSettings().connectors?.enabledNative ?? []);
    if (enabled) {
      current.add(connectorId);
    } else {
      current.delete(connectorId);
    }
    const next = Array.from(current);
    await configService.updateSettings({
      connectors: { enabledNative: next },
    });
    getConnectorRegistry().configure(next);
  }

  private async setChannelAccountEnabled(id: string, enabled: boolean): Promise<void> {
    const accountId = decodeCapabilityId(id, 'channel');
    const updated = await getChannelManager().updateAccount(accountId, { enabled });
    if (!updated) {
      throw new Error(`Channel account not found: ${accountId}`);
    }
  }
}

let instance: CapabilityCenterService | null = null;

export function getCapabilityCenterService(): CapabilityCenterService {
  if (!instance) {
    instance = new CapabilityCenterService();
  }
  return instance;
}

export { CapabilityCenterService };
