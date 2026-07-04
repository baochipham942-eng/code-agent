// ============================================================================
// Settings Search Index
// Static index of all settings entries for fuzzy search
// ============================================================================

import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import type { AccessSubject } from './accessControl';
import { canAccessSettingsTab, type SettingsTab } from './settingsTabs';
export type { SettingsTab } from './settingsTabs';

export interface SettingsEntry {
  tab: SettingsTab;
  labelKey: string;
  keywords: string[];
}

export type SearchSettingsOptions = AccessSubject;

/**
 * Static index of all settings items across tabs.
 * Each entry maps to a tab so search results can navigate directly.
 */
export const SETTINGS_INDEX: SettingsEntry[] = [
  // General
  { tab: 'general', labelKey: 'permissionMode', keywords: ['permission', 'permissions', 'safety', 'safe mode', 'yolo', 'auto edit', 'auto-edit', 'bypassPermissions'] },

  // Conversation
  { tab: 'conversation', labelKey: 'modelRoutingStrategy', keywords: ['routing', 'route', 'model routing', 'auto', 'direct', 'parallel'] },

  // Voice Input
  { tab: 'voiceInput', labelKey: 'voiceInput', keywords: ['voice', 'speech', 'mic', 'microphone', 'recording', 'transcription', 'asr'] },
  { tab: 'voiceInput', labelKey: 'whisperModel', keywords: ['whisper', 'model', 'asr', 'speech to text', 'local model', 'transcription model'] },
  { tab: 'voiceInput', labelKey: 'transcriptionLanguage', keywords: ['language', 'locale', 'multilingual', 'chinese', 'english'] },

  // Keybindings
  { tab: 'keybindings', labelKey: 'keybindingsConfig', keywords: ['keyboard', 'shortcut', 'shortcuts', 'hotkey', 'keybinding', 'command palette', 'cmd k', 'ctrl k'] },
  { tab: 'keybindings', labelKey: 'conflictDetection', keywords: ['conflict', 'occupied', 'macos', 'windows', 'linux', 'restore defaults'] },
  { tab: 'keybindings', labelKey: 'globalHotkeys', keywords: ['global hotkey', 'global launch', 'voice input', 'screenshot qa', 'appshot', 'voice'] },

  // Workspace
  { tab: 'workspace', labelKey: 'currentWorkingDirectory', keywords: ['workspace', 'cwd', 'working directory', 'directory', 'current'] },
  { tab: 'workspace', labelKey: 'configScope', keywords: ['personalization', 'config scope', 'scope', 'global config', 'project config', 'local config', 'user config'] },
  { tab: 'workspace', labelKey: 'recentDirectories', keywords: ['recent', 'recent directories', 'history', 'switch'] },
  { tab: 'workspace', labelKey: 'localBridge', keywords: ['bridge', 'local', 'ipc'] },
  { tab: 'workspace', labelKey: 'browserToolMode', keywords: ['browser', 'playwright', 'chrome', 'managed', 'desktop'] },

  // Automation
  { tab: 'automation', labelKey: 'scheduledTasks', keywords: ['cron', 'schedule', 'task', 'tasks', 'automation'] },
  { tab: 'automation', labelKey: 'newTask', keywords: ['new task', 'create', 'task', 'cron', 'automation wizard'] },
  { tab: 'automation', labelKey: 'executionHistory', keywords: ['history', 'execution', 'run', 'runs', 'log', 'logs'] },

  // User Management
  { tab: 'users', labelKey: 'registeredUsers', keywords: ['user', 'users', 'user management', 'registered users', 'email', 'last login', 'active'] },
  { tab: 'users', labelKey: 'userFields', keywords: ['profile', 'fields', 'registration time', 'registration source', 'device', 'session', 'message'] },
  { tab: 'invites', labelKey: 'inviteManagement', keywords: ['invite', 'invite code', 'invite codes', 'registration', 'code', 'usage count', 'validity'] },
  { tab: 'invites', labelKey: 'newInvite', keywords: ['create invite', 'new invite', 'create', 'issue', 'disable', 'enable'] },
  { tab: 'controlPlane', labelKey: 'releaseAudit', keywords: ['control plane', 'audit', 'release', 'rollout', 'gray release', 'signature', 'payload'] },
  { tab: 'controlPlane', labelKey: 'onlineVersionHash', keywords: ['hash', 'keyId', 'artifact', 'capability registry', 'prompt registry', 'cloud config', 'version'] },

  // Model
  { tab: 'model', labelKey: 'modelProviders', keywords: ['provider', 'providers', 'api', 'deepseek', 'claude', 'kimi', 'openai', 'zhipu', 'moonshot'] },
  { tab: 'model', labelKey: 'apiKey', keywords: ['apikey', 'api key', 'secret', 'key', 'auth', 'authentication', 'provider key', 'model credential'] },
  { tab: 'model', labelKey: 'modelSelection', keywords: ['model', 'select', 'selection', 'switch'] },
  { tab: 'model', labelKey: 'temperature', keywords: ['temperature', 'creativity', 'precision'] },
  { tab: 'model', labelKey: 'testConnection', keywords: ['test', 'connection'] },
  { tab: 'model', labelKey: 'relay', keywords: ['relay', 'custom', 'new-api', 'one-api', 'endpoint', 'base url'] },

  // Visual Models（生成模型：生图 / 生视频）
  { tab: 'visualModels', labelKey: 'imageModel', keywords: ['image', 'text to image', 't2i', 'wanx', 'tongyi wanxiang', 'gpt-image', 'cogview', 'flux', 'visual'] },
  { tab: 'visualModels', labelKey: 'videoModel', keywords: ['video', 'text to video', 'image to video', 't2v', 'i2v', 'hailuo', 'minimax', 'tongyi wanxiang', 'visual'] },
  { tab: 'visualModels', labelKey: 'customImageEndpoint', keywords: ['custom', 'endpoint', 'base url', 'openai', 'compatible', 'byo', 'sdxl', 'seedream'] },
  { tab: 'visualModels', labelKey: 'customVideoEndpoint', keywords: ['custom', 'video endpoint', 'base url'] },

  // Agent Engine（执行引擎）
  { tab: 'agentEngine', labelKey: 'agentEngine', keywords: ['execution engine', 'engine', 'billing', 'subscription', 'install state'] },
  { tab: 'agentEngine', labelKey: 'neoNativeEngine', keywords: ['native', 'neo', 'built-in', 'engine'] },
  { tab: 'agentEngine', labelKey: 'codexCli', keywords: ['codex', 'cli', 'engine', 'external engine'] },
  { tab: 'agentEngine', labelKey: 'claudeCode', keywords: ['claude code', 'cli', 'engine', 'external engine'] },
  { tab: 'agentEngine', labelKey: 'mimoCode', keywords: ['mimo', 'cli', 'engine', 'external engine'] },
  { tab: 'agentEngine', labelKey: 'kimiCode', keywords: ['kimi', 'cli', 'engine', 'external engine'] },
  { tab: 'agentEngine', labelKey: 'engineDefaultModel', keywords: ['engine', 'model', 'engine model', 'default model'] },

  // Appearance
  { tab: 'appearance', labelKey: 'theme', keywords: ['theme', 'dark', 'light', 'night'] },
  { tab: 'appearance', labelKey: 'fontSize', keywords: ['font', 'size', 'text'] },
  { tab: 'appearance', labelKey: 'language', keywords: ['language', 'chinese', 'english', 'internationalization', 'i18n'] },

  // Data
  { tab: 'cache', labelKey: 'dataManagement', keywords: ['data', 'statistics', 'session count', 'message count'] },
  { tab: 'cache', labelKey: 'databaseSize', keywords: ['database', 'size', 'storage'] },
  { tab: 'cache', labelKey: 'clearCache', keywords: ['cache', 'clear', 'cleanup', 'empty'] },

  // Capability Center
  { tab: 'capabilities', labelKey: 'localCapabilityInventory', keywords: ['capability', 'capabilities', 'capability center', 'marketplace', 'registry', 'audit'] },
  { tab: 'capabilities', labelKey: 'capabilityAudit', keywords: ['skill', 'mcp', 'tool', 'channel', 'connector', 'workflow', 'permission', 'risk', 'source'] },

  // Plugins
  { tab: 'plugins', labelKey: 'pluginMarketplace', keywords: ['plugin', 'plugins', 'marketplace', 'install', 'uninstall', 'enable', 'disable'] },
  { tab: 'plugins', labelKey: 'pluginVisibility', keywords: ['visibility', 'admin', 'user', 'regular user', 'admin only', 'visible to users', 'permission'] },
  { tab: 'plugins', labelKey: 'pluginPermissions', keywords: ['plugin permission', 'plugin risk', 'external service', 'hook permission'] },
  { tab: 'plugins', labelKey: 'marketplaceSource', keywords: ['marketplace source', 'github', 'npm', 'url', 'dir', 'source', 'refresh'] },

  // Hooks（Settings IA v2 下放普通用户后补索引——此前 admin-only 从未被索引）
  { tab: 'hooks', labelKey: 'hookConfig', keywords: ['hook', 'hooks', 'pre', 'post', 'intercept', 'auto run', 'event'] },

  // MCP
  { tab: 'mcp', labelKey: 'mcpServers', keywords: ['mcp', 'server', 'servers', 'protocol', 'tool', 'resource'] },
  { tab: 'mcp', labelKey: 'mcpOAuth', keywords: ['mcp oauth', 'oauth', 'reauthorize', 'revoke', 'token', 'authorization'] },
  { tab: 'mcp', labelKey: 'mcpCredentialBoundary', keywords: ['mcp env', 'mcp header', 'header auth', 'env secret', 'authorization', 'bearer', 'credential', 'secret'] },
  { tab: 'mcp', labelKey: 'mcpCodexCli', keywords: ['codex', 'sandbox', 'cross verify'] },
  { tab: 'mcp', labelKey: 'mcpLocalBridge', keywords: ['bridge', 'local'] },
  { tab: 'mcp', labelKey: 'cloudRefresh', keywords: ['cloud', 'refresh', 'config'] },

  // Skills
  { tab: 'skills', labelKey: 'skillLibraryManagement', keywords: ['skill', 'skills', 'library', 'management', 'install', 'uninstall'] },
  { tab: 'skills', labelKey: 'searchSkill', keywords: ['search', 'skill', 'skillsmp'] },
  { tab: 'skills', labelKey: 'customRepository', keywords: ['custom', 'repository', 'github'] },

  // Channels
  { tab: 'channels', labelKey: 'multichannelAccess', keywords: ['channel', 'channels', 'access', 'http', 'api'] },
  { tab: 'channels', labelKey: 'channelPrivacyPolicy', keywords: ['channel privacy', 'privacy policy', 'default redaction', 'local-redact', 'allow-raw', 'channel token', 'app secret', 'bot token'] },
  { tab: 'channels', labelKey: 'lowNoiseNotifications', keywords: ['notification', 'low noise', 'typing', 'progress spam', 'desktop reply notification', 'channel reply'] },
  { tab: 'channels', labelKey: 'feishu', keywords: ['feishu', 'lark', 'webhook', 'bot'] },
  { tab: 'channels', labelKey: 'telegram', keywords: ['telegram', 'bot', 'tg'] },
  { tab: 'channels', labelKey: 'httpApi', keywords: ['http', 'api', 'rest', 'port', 'cors'] },

  // Memory
  { tab: 'memory', labelKey: 'lightMemory', keywords: ['memory', 'file', 'memory file'] },
  { tab: 'memory', labelKey: 'sessionStats', keywords: ['session', 'stats', 'statistics', 'depth', 'active'] },
  { tab: 'memory', labelKey: 'modelUsage', keywords: ['model', 'usage', 'distribution'] },

  // Screen Memory
  { tab: 'openchronicle', labelKey: 'automaticScreenMemory', keywords: ['screen memory', 'openchronicle', 'daemon', 'desktop activity'] },
  { tab: 'openchronicle', labelKey: 'manualDesktopActivity', keywords: ['native desktop', 'tauri', 'desktop', 'desktop activity', 'screenshot', 'recording'] },

  // Privacy
  { tab: 'privacy', labelKey: 'permissionDataBoundary', keywords: ['privacy boundary', 'permission boundary', 'data boundary', 'local first', 'cloud exception', 'diagnostic exception'] },
  { tab: 'privacy', labelKey: 'voiceTranscription', keywords: ['transcription', 'voice paste', 'whisper', 'groq', 'microphone', 'desktop audio', 'channel audio'] },
  { tab: 'privacy', labelKey: 'diagnosticBundle', keywords: ['diagnostic bundle', 'trace', 'stack trace', 'scrub', 'redaction', 'telemetry'] },
  { tab: 'privacy', labelKey: 'credentialInventory', keywords: ['auth inventory', 'credential inventory', 'api key', 'oauth', 'channel token', 'browser relay', 'mcp header'] },
  { tab: 'privacy', labelKey: 'browserRelay', keywords: ['browser relay', 'chrome extension', 'debugger', 'tabs', 'activeTab', 'host permissions'] },

  // Update
  { tab: 'update', labelKey: 'versionUpdate', keywords: ['update', 'version', 'upgrade', 'download'] },
  { tab: 'update', labelKey: 'checkForUpdates', keywords: ['check', 'update'] },

  // About
  { tab: 'about', labelKey: 'about', keywords: ['about', 'version', 'tech stack'] },
];

type SearchLabelMap = Record<string, string | undefined>;
type TabLabelMap = Partial<Record<SettingsTab, string>>;

const zhSearchIndex = zh.settings.searchIndex as SearchLabelMap;
const enSearchIndex = en.settings.searchIndex as SearchLabelMap;
const zhTabLabels = zh.settings.tabs as TabLabelMap;
const enTabLabels = en.settings.tabs as TabLabelMap;

const SETTINGS_SEARCH_TEXT = SETTINGS_INDEX.map((entry) => (
  [
    ...entry.keywords,
    zhSearchIndex[entry.labelKey],
    enSearchIndex[entry.labelKey],
    zhTabLabels[entry.tab],
    enTabLabels[entry.tab],
  ]
    .filter((term): term is string => typeof term === 'string' && term.length > 0)
    .join('\n')
    .toLowerCase()
));

/**
 * Search settings entries by query string.
 * Matches against precomputed keywords plus zh/en labels and tab labels.
 */
export function searchSettings(query: string, options?: SearchSettingsOptions): SettingsEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  return SETTINGS_INDEX.filter((entry, index) => {
    if (!canAccessSettingsTab(entry.tab, options)) return false;
    return SETTINGS_SEARCH_TEXT[index].includes(q);
  });
}
