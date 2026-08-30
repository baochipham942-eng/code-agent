// ============================================================================
// 首屏欢迎海报的纯数据（Grok Build 构图：大 logo + 标题 + 高亮 + 动作表）。
// 无 Ink 依赖，可供 WelcomeCard 渲染、terminal 横幅、单测共用。
// ============================================================================

import os from 'os';

/** 全屏海报用的星簇 logo（约 7 行，对标 Grok 首屏 logo 体量） */
export const NEO_LOGO_FULL: readonly string[] = [
  '        ·          ',
  '      ·  ◇  ·      ',
  '    ◇  ·   ·  ◇    ',
  '  ·             ·  ',
  ' ◇      ◈      ◇   ',
  '  ·             ·  ',
  '    ◇  ·   ·  ◇    ',
  '      ·  ◇  ·      ',
  '        ·          ',
];

/** 矮终端 / 非 TTY 横幅用的 3 行紧缩 logo（保留 ◈ 识别符） */
export const NEO_LOGO_COMPACT: readonly string[] = [
  '   ◇   ',
  ' ◇ ◈ ◇ ',
  '   ◇   ',
];

export const WELCOME_HEADLINE = '终端里的 cowork';
export const WELCOME_SUBHEAD = '直接打字开始，或 /model 换模型';

export interface WelcomeAction {
  label: string;
  shortcut: string;
}

/** 动作表只列 Ink 里真实可触发的入口，不编不存在的 picker */
export const WELCOME_ACTIONS: readonly WelcomeAction[] = [
  { label: 'Switch model', shortcut: '/model' },
  { label: 'Sessions', shortcut: '/sessions' },
  { label: 'Help', shortcut: '/help' },
  { label: 'Quit', shortcut: 'ctrl+q' },
];

/** 终端矮于此时改用紧缩 logo，避免海报把输入区顶出屏 */
export const WELCOME_COMPACT_ROWS = 22;

export function abbreviateHomePath(cwd: string, home = os.homedir()): string {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/** Grok 顶左那一行：`main  ~/Downloads/ai` */
export function formatWorkspaceLine(
  cwd: string,
  gitBranch: string,
  gitDirty?: boolean,
  home?: string,
): string {
  const path = abbreviateHomePath(cwd, home);
  if (!gitBranch) return path;
  return `${gitBranch}${gitDirty ? '*' : ''}  ${path}`;
}
