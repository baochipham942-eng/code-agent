// ============================================================================
// Alma Plugin Registry - featured plugin mapping for code-agent
// ============================================================================
// Alma plugin registry exposes ui/theme/provider plugin types. code-agent
// installs those entries as managed plugin assets first; runtime execution,
// theme injection, and provider OAuth stay behind their dedicated surfaces.
// ============================================================================

export const ALMA_PLUGIN_REGISTRY_REVIEWED_AT = '2026-06-13';

export type AlmaPluginKind = 'ui' | 'theme' | 'provider' | 'command';

export type AlmaPluginRecommendationTier =
  | 'default_visible'
  | 'conditional'
  | 'not_default';

export interface AlmaFeaturedPluginEntry {
  id: string;
  name: string;
  kind: AlmaPluginKind;
  author: string;
  featured: true;
  recommendationTier: AlmaPluginRecommendationTier;
  codeAgentStatus: string;
  riskNote: string;
}

export interface AlmaPluginRegistryPayload {
  version?: string;
  plugins?: AlmaPluginRegistryItem[];
}

export interface AlmaPluginRegistryItem {
  id?: string;
  name?: string;
  type?: string | string[];
  author?: string | { name?: string; email?: string; url?: string };
  featured?: boolean;
  description?: string;
  version?: string;
  repository?: string;
  path?: string;
  commands?: string[];
}

export interface AlmaPluginSlashCommandCandidate {
  id: string;
  name: string;
  commands: string[];
}

export type AlmaPluginAdapterSurface =
  | 'status_bar'
  | 'theme'
  | 'provider'
  | 'slash_command';

export type AlmaPluginInstallability =
  | 'reference_only'
  | 'managed_ui_asset'
  | 'managed_theme_asset'
  | 'managed_provider_asset'
  | 'managed_command_asset';

export interface AlmaPluginCodeAgentAdapterSpec {
  id: string;
  name: string;
  kind: AlmaPluginKind;
  surface: AlmaPluginAdapterSurface;
  installability: AlmaPluginInstallability;
  canInstall: boolean;
  canExposeInSlash: boolean;
  requiredRuntimeCapabilities: string[];
  unsupportedReason: string;
}

export const ALMA_FEATURED_PLUGIN_REGISTRY: AlmaFeaturedPluginEntry[] = [
  {
    id: 'token-counter',
    name: 'Token Counter',
    kind: 'ui',
    author: 'Alma Team',
    featured: true,
    recommendationTier: 'default_visible',
    codeAgentStatus: '现有 token/cost UI 已覆盖主要需求；可先作为受管 UI asset 安装，运行由 UI slot 授权控制。',
    riskNote: '安装不等于执行第三方 UI 代码；status/sidebar/widget slot 必须单独授予。',
  },
  {
    id: 'catppuccin-theme',
    name: 'Catppuccin Theme',
    kind: 'theme',
    author: 'Alma Team',
    featured: true,
    recommendationTier: 'conditional',
    codeAgentStatus: '可先作为受管 theme asset 安装；应用主题仍由 Appearance/theme API 接管。',
    riskNote: '安装不等于立即应用主题；主题预览、回滚和变量注入必须在 Appearance surface 完成。',
  },
  {
    id: 'openai-codex-auth',
    name: 'OpenAI Codex Auth',
    kind: 'provider',
    author: 'Alma Community',
    featured: true,
    recommendationTier: 'conditional',
    codeAgentStatus: '可先作为受管 provider asset 安装；OAuth 和模型接入仍走 provider 设置页。',
    riskNote: '安装不等于 OAuth 授权；账号 token、quota 和撤销仍必须在 provider 设置页完成。',
  },
  {
    id: 'cursor-auth',
    name: 'Cursor Auth',
    kind: 'provider',
    author: 'Alma Community',
    featured: true,
    recommendationTier: 'conditional',
    codeAgentStatus: '可先作为受管 provider asset 安装；面向 Cursor 订阅用户的代理授权仍走 provider 设置页。',
    riskNote: '安装不等于启动本地 proxy；账号作用域、代理行为和失败隔离必须显式说明。',
  },
];

export function getAlmaFeaturedPlugins(
  registry: AlmaFeaturedPluginEntry[] = ALMA_FEATURED_PLUGIN_REGISTRY,
): AlmaFeaturedPluginEntry[] {
  return registry.filter((plugin) => plugin.featured);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePluginKind(value: unknown): AlmaPluginKind | 'unsupported' {
  const raw = Array.isArray(value) ? value[0] : value;
  switch (normalizeString(raw)) {
    case 'ui':
      return 'ui';
    case 'theme':
      return 'theme';
    case 'provider':
      return 'provider';
    case 'command':
    case 'commands':
      return 'command';
    default:
      return 'unsupported';
  }
}

function normalizeAuthor(value: AlmaPluginRegistryItem['author']): string | undefined {
  if (typeof value === 'string') {
    return normalizeString(value);
  }
  return normalizeString(value?.name);
}

function normalizeCommands(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(values.map(normalizeString).filter((value): value is string => Boolean(value))));
}

function toFeaturedPluginEntry(plugin: AlmaPluginRegistryItem): AlmaFeaturedPluginEntry | null {
  const id = normalizeString(plugin.id) || normalizeString(plugin.name);
  const name = normalizeString(plugin.name) || id;
  const kind = normalizePluginKind(plugin.type);
  if (!id || !name || kind === 'unsupported') {
    return null;
  }

  return {
    id,
    name,
    kind,
    author: normalizeAuthor(plugin.author) || 'Unknown',
    featured: true,
    recommendationTier: kind === 'ui' ? 'default_visible' : 'conditional',
    codeAgentStatus: kind === 'command'
      ? 'command 型插件可安装为受管资产，启用后进入文件式 slash command。'
      : `${kind} 型插件可安装为受管资产；真实运行仍由对应 runtime surface 接管。`,
    riskNote: kind === 'provider'
      ? '安装不等于 OAuth 授权；账号 token、quota 和撤销仍必须在 provider 设置页完成。'
      : kind === 'theme'
        ? '安装不等于立即应用主题；主题预览、回滚和变量注入必须在 Appearance surface 完成。'
        : kind === 'ui'
          ? '安装不等于执行第三方 UI 代码；status/sidebar/widget slot 必须单独授予。'
          : '启用后只暴露声明的 command 文件，不执行任意 JS。',
  };
}

export function normalizeAlmaPluginRegistryFeatured(
  payload?: AlmaPluginRegistryPayload,
): AlmaFeaturedPluginEntry[] {
  const plugins = payload?.plugins;
  if (!Array.isArray(plugins)) {
    return ALMA_FEATURED_PLUGIN_REGISTRY;
  }

  return plugins
    .filter((plugin) => plugin.featured === true)
    .map(toFeaturedPluginEntry)
    .filter((plugin): plugin is AlmaFeaturedPluginEntry => Boolean(plugin));
}

export function getAlmaPluginSlashCommandCandidates(
  payload?: AlmaPluginRegistryPayload,
): AlmaPluginSlashCommandCandidate[] {
  const plugins = payload?.plugins;
  if (!Array.isArray(plugins)) {
    return [];
  }

  return plugins
    .filter((plugin) => plugin.featured === true && normalizePluginKind(plugin.type) === 'command')
    .map((plugin) => {
      const id = normalizeString(plugin.id) || normalizeString(plugin.name);
      const name = normalizeString(plugin.name) || id;
      const commands = normalizeCommands(plugin.commands);
      if (!id || !name || commands.length === 0) {
        return null;
      }
      return { id, name, commands };
    })
    .filter((plugin): plugin is AlmaPluginSlashCommandCandidate => Boolean(plugin));
}

export function adaptAlmaPluginToCodeAgentSpec(
  plugin: Pick<AlmaFeaturedPluginEntry, 'id' | 'name' | 'kind'>,
): AlmaPluginCodeAgentAdapterSpec {
  switch (plugin.kind) {
    case 'ui':
      return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        surface: 'status_bar',
        installability: 'managed_ui_asset',
        canInstall: true,
        canExposeInSlash: false,
        requiredRuntimeCapabilities: ['marketplace-plugin-assets', 'ui-slot:status-bar', 'plugin-permissions:ui-readonly'],
        unsupportedReason: '可先安装为受管资产；真正渲染仍需要 status/sidebar/widget slot 授权和运行时接入。',
      };
    case 'theme':
      return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        surface: 'theme',
        installability: 'managed_theme_asset',
        canInstall: true,
        canExposeInSlash: false,
        requiredRuntimeCapabilities: ['marketplace-plugin-assets', 'appearance:theme-api', 'theme:preview', 'theme:rollback'],
        unsupportedReason: '可先安装为受管资产；应用主题仍需要 Appearance theme API、预览和回滚能力。',
      };
    case 'provider':
      return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        surface: 'provider',
        installability: 'managed_provider_asset',
        canInstall: true,
        canExposeInSlash: false,
        requiredRuntimeCapabilities: ['marketplace-plugin-assets', 'provider-auth:oauth', 'secret-storage', 'quota-visibility', 'auth:revoke'],
        unsupportedReason: '可先安装为受管资产；OAuth、secret storage、quota 和撤销入口仍由 provider 设置页处理。',
      };
    case 'command':
      return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        surface: 'slash_command',
        installability: 'managed_command_asset',
        canInstall: true,
        canExposeInSlash: true,
        requiredRuntimeCapabilities: ['marketplace-plugin-assets', 'command-manifest', 'plugin-permissions:command'],
        unsupportedReason: '可安装为受管资产；启用后只复制声明的 command 文件进入 slash command。',
      };
    default:
      return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        surface: 'slash_command',
        installability: 'reference_only',
        canInstall: false,
        canExposeInSlash: false,
        requiredRuntimeCapabilities: [],
        unsupportedReason: '当前 code-agent 不支持这个 Alma plugin 类型。',
      };
  }
}

export function getAlmaPluginAdapterSpecs(
  plugins: AlmaFeaturedPluginEntry[] = ALMA_FEATURED_PLUGIN_REGISTRY,
): AlmaPluginCodeAgentAdapterSpec[] {
  return plugins.map(adaptAlmaPluginToCodeAgentSpec);
}
