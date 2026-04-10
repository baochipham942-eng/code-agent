// ============================================================================
// Settings Search Index
// Static index of all settings entries for fuzzy search
// ============================================================================

export type SettingsTab = 'general' | 'model' | 'appearance' | 'cache' | 'mcp' | 'skills' | 'channels' | 'memory' | 'update' | 'about';

export interface SettingsEntry {
  tab: SettingsTab;
  tabLabel: string;
  label: string;
  keywords: string[];
}

/**
 * Static index of all settings items across tabs.
 * Each entry maps to a tab so search results can navigate directly.
 */
export const SETTINGS_INDEX: SettingsEntry[] = [
  // General
  { tab: 'general', tabLabel: '通用', label: '安全模式', keywords: ['permission', 'safety', '权限', '安全', 'YOLO', '自动编辑', 'bypassPermissions'] },

  // Model
  { tab: 'model', tabLabel: '模型', label: '模型供应商', keywords: ['provider', '供应商', 'API', 'deepseek', 'claude', 'kimi', 'openai', '智谱', 'moonshot'] },
  { tab: 'model', tabLabel: '模型', label: 'API Key', keywords: ['apikey', '密钥', 'key', '认证'] },
  { tab: 'model', tabLabel: '模型', label: '模型选择', keywords: ['model', '模型', '选择', '切换'] },
  { tab: 'model', tabLabel: '模型', label: '温度', keywords: ['temperature', '温度', '创造性', '精确'] },
  { tab: 'model', tabLabel: '模型', label: '测试连接', keywords: ['test', 'connection', '测试', '连接'] },

  // Appearance
  { tab: 'appearance', tabLabel: '外观', label: '主题', keywords: ['theme', '主题', '深色', '浅色', 'dark', 'light', '夜间'] },
  { tab: 'appearance', tabLabel: '外观', label: '字体大小', keywords: ['font', 'size', '字体', '大小', '文字'] },
  { tab: 'appearance', tabLabel: '外观', label: '语言', keywords: ['language', '语言', '中文', 'English', '国际化', 'i18n'] },

  // Data
  { tab: 'cache', tabLabel: '数据', label: '数据管理', keywords: ['data', '数据', '统计', '会话数', '消息数'] },
  { tab: 'cache', tabLabel: '数据', label: '数据库大小', keywords: ['database', '数据库', '大小', '存储'] },
  { tab: 'cache', tabLabel: '数据', label: '清空缓存', keywords: ['cache', 'clear', '缓存', '清理', '清空'] },

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
export function searchSettings(query: string): SettingsEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  return SETTINGS_INDEX.filter((entry) => {
    if (entry.label.toLowerCase().includes(q)) return true;
    if (entry.tabLabel.toLowerCase().includes(q)) return true;
    return entry.keywords.some((kw) => kw.toLowerCase().includes(q));
  });
}
