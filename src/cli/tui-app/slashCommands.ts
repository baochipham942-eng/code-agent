// ============================================================================
// Slash 命令菜单数据（纯函数，无 Ink 依赖，可单测）
// 数据源：统一命令注册表（surfaces 含 cli）+ chat.ts 的本地命令
// ============================================================================

export interface SlashItem {
  id: string;
  name: string;
  description: string;
}

/** chat.ts handleCommand 的本地命令（不进统一注册表的那部分） */
export const LOCAL_SLASH_ITEMS: SlashItem[] = [
  { id: 'help', name: 'help', description: '帮助' },
  { id: 'login', name: 'login', description: '认证状态 & 配置 API key' },
  { id: 'model', name: 'model', description: '切换模型 / 列出可用模型' },
  { id: 'tools', name: 'tools', description: '列出已加载工具' },
  { id: 'skills', name: 'skills', description: '列出已激活 skill' },
  { id: 'compact', name: 'compact', description: '触发上下文压缩' },
  { id: 'clear', name: 'clear', description: '清空会话' },
  { id: 'history', name: 'history', description: '对话历史' },
  { id: 'sessions', name: 'sessions', description: '列出会话' },
  { id: 'session', name: 'session', description: '当前会话信息' },
  { id: 'restore', name: 'restore', description: '恢复指定会话' },
  { id: 'config', name: 'config', description: '显示当前配置' },
  { id: 'vim', name: 'vim', description: '切换 vi 模式' },
  { id: 'exit', name: 'exit', description: '退出' },
];

/** 合并注册表命令与本地命令（注册表优先，本地补充，按 name 去重） */
export function buildSlashItems(
  registryDefs: Array<{ id: string; name: string; description: string }>,
): SlashItem[] {
  const seen = new Set<string>();
  const items: SlashItem[] = [];
  for (const def of registryDefs) {
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    items.push({ id: def.id, name: def.name, description: def.description });
  }
  for (const local of LOCAL_SLASH_ITEMS) {
    if (seen.has(local.name)) continue;
    seen.add(local.name);
    items.push(local);
  }
  return items;
}

/** 模糊过滤：前缀命中排前，子串命中排后，各自保持原有顺序 */
export function filterSlashCommands(query: string, items: SlashItem[]): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const prefix: SlashItem[] = [];
  const substring: SlashItem[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) {
      prefix.push(item);
    } else if (name.includes(q)) {
      substring.push(item);
    }
  }
  return [...prefix, ...substring];
}
