// ============================================================================
// Settings Search Index
// Static index of all settings entries for fuzzy search
// ============================================================================

import type { AccessSubject } from './accessControl';
import { canAccessSettingsTab, type SettingsTab } from './settingsTabs';
export type { SettingsTab } from './settingsTabs';

export interface SettingsEntry {
  tab: SettingsTab;
  tabLabel: string;
  label: string;
  keywords: string[];
}

export type SearchSettingsOptions = AccessSubject;

/**
 * Static index of all settings items across tabs.
 * Each entry maps to a tab so search results can navigate directly.
 */
export const SETTINGS_INDEX: SettingsEntry[] = [
  // General
  { tab: 'general', tabLabel: '权限与安全', label: '安全模式', keywords: ['permission', 'safety', '权限', '安全', 'YOLO', '自动编辑', 'bypassPermissions'] },

  // Conversation
  { tab: 'conversation', tabLabel: '对话', label: '模型路由策略', keywords: ['routing', 'route', '模型路由', '路由', 'auto', 'direct', 'parallel'] },

  // Keybindings
  { tab: 'keybindings', tabLabel: '快捷键', label: '快捷键配置', keywords: ['keyboard', 'shortcut', 'hotkey', 'keybinding', '快捷键', '热键', '键盘', '命令面板', 'Cmd K', 'Ctrl K'] },
  { tab: 'keybindings', tabLabel: '快捷键', label: '冲突检测', keywords: ['conflict', '冲突', '占用', 'macOS', 'Windows', 'Linux', '恢复默认'] },
  { tab: 'keybindings', tabLabel: '快捷键', label: '全局热键', keywords: ['global hotkey', '全局唤起', '语音输入', '截图问答', 'appshot', 'voice'] },

  // Workspace
  { tab: 'workspace', tabLabel: '工作区', label: '当前工作目录', keywords: ['workspace', '工作区', 'cwd', 'working directory', '目录', '当前'] },
  { tab: 'workspace', tabLabel: '工作区', label: '配置作用域', keywords: ['personalization', 'config scope', 'scope', '配置作用域', '全局配置', '项目配置', '本地配置', '个性化', 'user config', 'project config', 'local config'] },
  { tab: 'workspace', tabLabel: '工作区', label: '最近目录', keywords: ['recent', '最近', 'recent directories', '历史', '切换'] },
  { tab: 'workspace', tabLabel: '工作区', label: '本地桥', keywords: ['bridge', 'local', '桥接', '本地', 'ipc'] },
  { tab: 'workspace', tabLabel: '工作区', label: '浏览器工具模式', keywords: ['browser', '浏览器', 'playwright', 'chrome', 'managed', 'desktop'] },

  // Automation
  { tab: 'automation', tabLabel: '自动化', label: '定时任务', keywords: ['cron', '定时', 'schedule', '任务', '自动化', 'automation'] },
  { tab: 'automation', tabLabel: '自动化', label: '新建任务', keywords: ['new task', 'create', '新建', '任务', 'cron', '自动化向导'] },
  { tab: 'automation', tabLabel: '自动化', label: '执行历史', keywords: ['history', 'execution', '执行', '历史', '运行', '日志'] },

  // User Management
  { tab: 'users', tabLabel: '用户管理', label: '注册用户', keywords: ['user', 'users', '用户', '用户管理', '注册用户', 'email', '邮箱', 'last login', '上次登录', '活跃'] },
  { tab: 'users', tabLabel: '用户管理', label: '用户字段', keywords: ['profile', '字段', '注册时间', '注册来源', '设备', '会话', '消息'] },
  { tab: 'invites', tabLabel: '邀请码管理', label: '邀请码管理', keywords: ['invite', '邀请码', '邀请码管理', '注册', 'code', '使用次数', '有效期'] },
  { tab: 'invites', tabLabel: '邀请码管理', label: '新建邀请码', keywords: ['create invite', 'new invite', '创建', '新建', '发放', '停用', '启用'] },
  { tab: 'controlPlane', tabLabel: '控制平面', label: '发布审计', keywords: ['control plane', 'audit', 'release', 'rollout', '发布', '审计', '灰度', '签名', 'payload'] },
  { tab: 'controlPlane', tabLabel: '控制平面', label: '线上版本与 hash', keywords: ['hash', 'keyId', 'artifact', 'capability registry', 'prompt registry', 'cloud config', '版本'] },

  // Model
  { tab: 'model', tabLabel: '模型', label: '模型供应商', keywords: ['provider', '供应商', 'API', 'deepseek', 'claude', 'kimi', 'openai', '智谱', 'moonshot'] },
  { tab: 'model', tabLabel: '模型', label: 'API Key', keywords: ['apikey', '密钥', 'key', '认证'] },
  { tab: 'model', tabLabel: '模型', label: '模型选择', keywords: ['model', '模型', '选择', '切换'] },
  { tab: 'model', tabLabel: '模型', label: '温度', keywords: ['temperature', '温度', '创造性', '精确'] },
  { tab: 'model', tabLabel: '模型', label: '测试连接', keywords: ['test', 'connection', '测试', '连接'] },
  { tab: 'model', tabLabel: '模型', label: '中转站', keywords: ['relay', '中转', '自定义', 'custom', 'new-api', 'one-api', '接口地址', 'base url'] },

  // Agent Engine
  { tab: 'agentEngine', tabLabel: 'Agent 引擎', label: 'Codex CLI', keywords: ['codex', 'cli', '引擎', 'engine', '外部引擎'] },
  { tab: 'agentEngine', tabLabel: 'Agent 引擎', label: 'Claude Code', keywords: ['claude code', 'cli', '引擎', 'engine', '外部引擎'] },
  { tab: 'agentEngine', tabLabel: 'Agent 引擎', label: '引擎默认模型', keywords: ['engine', 'model', '引擎模型', '默认模型'] },

  // Appearance
  { tab: 'appearance', tabLabel: '外观', label: '主题', keywords: ['theme', '主题', '深色', '浅色', 'dark', 'light', '夜间'] },
  { tab: 'appearance', tabLabel: '外观', label: '字体大小', keywords: ['font', 'size', '字体', '大小', '文字'] },
  { tab: 'appearance', tabLabel: '外观', label: '语言', keywords: ['language', '语言', '中文', 'English', '国际化', 'i18n'] },

  // Data
  { tab: 'cache', tabLabel: '数据与存储', label: '数据管理', keywords: ['data', '数据', '统计', '会话数', '消息数'] },
  { tab: 'cache', tabLabel: '数据与存储', label: '数据库大小', keywords: ['database', '数据库', '大小', '存储'] },
  { tab: 'cache', tabLabel: '数据与存储', label: '清空缓存', keywords: ['cache', 'clear', '缓存', '清理', '清空'] },

  // Capability Center
  { tab: 'capabilities', tabLabel: '能力中心', label: '本地能力库存', keywords: ['capability', 'capabilities', '能力', '能力中心', 'marketplace', 'registry', '审计'] },
  { tab: 'capabilities', tabLabel: '能力中心', label: 'Skill / MCP / Tool / Channel 审计', keywords: ['skill', 'mcp', 'tool', 'channel', 'connector', 'workflow', '权限', '风险', '来源'] },

  // Plugins
  { tab: 'plugins', tabLabel: '插件管理', label: '插件市场', keywords: ['plugin', 'plugins', '插件', 'marketplace', '市场', '安装', '卸载', '启用', '禁用'] },
  { tab: 'plugins', tabLabel: '插件管理', label: '插件可见性', keywords: ['visibility', 'admin', 'user', '普通用户', '管理员', '仅管理员可见', '普通用户可见', '权限'] },
  { tab: 'plugins', tabLabel: '插件管理', label: 'Marketplace 源', keywords: ['marketplace source', 'github', 'npm', 'url', 'dir', '源', '刷新'] },

  // MCP
  { tab: 'mcp', tabLabel: 'MCP', label: 'MCP 服务器', keywords: ['mcp', 'server', '服务器', 'protocol', '工具', '资源'] },
  { tab: 'mcp', tabLabel: 'MCP', label: 'Codex CLI', keywords: ['codex', 'sandbox', '沙箱', '交叉验证', 'cross verify'] },
  { tab: 'mcp', tabLabel: 'MCP', label: '本地桥接', keywords: ['bridge', 'local', '桥接', '本地'] },
  { tab: 'mcp', tabLabel: 'MCP', label: '云端刷新', keywords: ['cloud', 'refresh', '云端', '刷新', '配置'] },

  // Skills
  { tab: 'skills', tabLabel: 'Skills', label: 'Skill 库管理', keywords: ['skill', '技能', '库', '管理', '安装', '卸载'] },
  { tab: 'skills', tabLabel: 'Skills', label: '搜索 Skill', keywords: ['search', 'skill', '搜索', '技能', 'skillsmp'] },
  { tab: 'skills', tabLabel: 'Skills', label: '自定义仓库', keywords: ['custom', 'repository', '自定义', '仓库', 'github'] },

  // Channels
  { tab: 'channels', tabLabel: '通道', label: '多通道接入', keywords: ['channel', '通道', '接入', 'http', 'api'] },
  { tab: 'channels', tabLabel: '通道', label: '飞书', keywords: ['feishu', '飞书', 'lark', 'webhook', 'bot'] },
  { tab: 'channels', tabLabel: '通道', label: 'Telegram', keywords: ['telegram', 'bot', 'tg'] },
  { tab: 'channels', tabLabel: '通道', label: 'HTTP API', keywords: ['http', 'api', 'rest', '端口', 'port', 'cors'] },

  // Memory
  { tab: 'memory', tabLabel: '记忆', label: 'Light Memory', keywords: ['memory', '记忆', '文件', '记忆文件'] },
  { tab: 'memory', tabLabel: '记忆', label: '会话统计', keywords: ['session', 'stats', '会话', '统计', '深度', '活跃'] },
  { tab: 'memory', tabLabel: '记忆', label: '模型使用', keywords: ['model', 'usage', '模型', '使用', '分布'] },

  // Screen Memory
  { tab: 'openchronicle', tabLabel: '屏幕记忆', label: '自动屏幕记忆', keywords: ['screen memory', '屏幕记忆', 'openchronicle', 'daemon', '桌面活动'] },
  { tab: 'openchronicle', tabLabel: '屏幕记忆', label: '手动桌面活动', keywords: ['native desktop', 'tauri', 'desktop', '桌面活动', '截图', '录音'] },

  // Update
  { tab: 'update', tabLabel: '更新', label: '版本更新', keywords: ['update', 'version', '更新', '版本', '升级', '下载'] },
  { tab: 'update', tabLabel: '更新', label: '检查更新', keywords: ['check', 'update', '检查', '更新'] },

  // About
  { tab: 'about', tabLabel: '关于', label: '关于', keywords: ['about', '关于', '版本', '技术栈'] },
];

/**
 * Search settings entries by query string.
 * Matches against label and keywords using simple substring matching.
 */
export function searchSettings(query: string, options?: SearchSettingsOptions): SettingsEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  return SETTINGS_INDEX.filter((entry) => {
    if (!canAccessSettingsTab(entry.tab, options)) return false;
    if (entry.label.toLowerCase().includes(q)) return true;
    if (entry.tabLabel.toLowerCase().includes(q)) return true;
    return entry.keywords.some((kw) => kw.toLowerCase().includes(q));
  });
}
