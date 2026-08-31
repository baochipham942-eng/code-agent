// ============================================================================
// 首屏欢迎海报的纯数据（Grok Build 构图：大 logo + 标题 + 高亮 + 动作表）。
// 无 Ink 依赖，可供 WelcomeCard 渲染、terminal 横幅、单测共用。
// ============================================================================

import os from 'os';

/** 全屏海报用的星簇 logo（密点菱形，体量对标 Grok 点阵 G） */
export const NEO_LOGO_FULL: readonly string[] = [
  '        ·        ',
  '      · · ·      ',
  '    · · ◈ · ·    ',
  '  · · ◇ · ◇ · ·  ',
  ' · · ·  ◆  · · · ',
  '  · · ◇ · ◇ · ·  ',
  '    · · ◈ · ·    ',
  '      · · ·      ',
  '        ·        ',
];

/** 矮终端 / 非 TTY 横幅用的 3 行紧缩 logo（保留 ◈ 识别符） */
export const NEO_LOGO_COMPACT: readonly string[] = [
  '   ◇   ',
  ' ◇ ◈ ◇ ',
  '   ◇   ',
];

export const WELCOME_HEADLINE = '终端里的 cowork';
export const WELCOME_SUBHEAD = '直接打字开始，或 /model 换模型';

export type WelcomeActionId = 'model' | 'sessions' | 'help' | 'quit';

export interface WelcomeAction {
  id: WelcomeActionId;
  label: string;
  shortcut: string;
}

/** 动作表只列 Ink 里真实可触发的入口，不编不存在的 picker */
export const WELCOME_ACTIONS: readonly WelcomeAction[] = [
  { id: 'model', label: 'Switch model', shortcut: '/model' },
  { id: 'sessions', label: 'Sessions', shortcut: '/sessions' },
  { id: 'help', label: 'Help', shortcut: '/help' },
  { id: 'quit', label: 'Quit', shortcut: 'ctrl+q' },
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

/** 首屏海报在 live 区的几何（0-based 行号，相对整个终端顶）。供鼠标命中。 */
function welcomeCardGeometry(termRows: number, chromeRows: number, compact: boolean): {
  action0: number;
  actionCount: number;
} {
  const live = Math.max(termRows - chromeRows, 0);
  const workspace = 2;
  const logoLines = compact ? NEO_LOGO_COMPACT.length : NEO_LOGO_FULL.length;
  const contentLines = compact
    ? 3 + WELCOME_ACTIONS.length
    : 5 + WELCOME_ACTIONS.length;
  const inner = Math.max(logoLines, contentLines);
  const padY = compact ? 0 : 1;
  const cardHeight = inner + 2 + padY * 2;
  const centerBudget = Math.max(live - workspace, 0);
  const cardTop = workspace + Math.max(0, Math.floor((centerBudget - cardHeight) / 2));
  const titleBlock = compact ? 3 : 5;
  return {
    action0: cardTop + 1 + padY + titleBlock,
    actionCount: WELCOME_ACTIONS.length,
  };
}

/** 终端 1-based 行号 → 动作下标；未点中返回 null */
export function welcomeActionIndexAt(
  clickRow1: number,
  termRows: number,
  chromeRows: number,
  compact: boolean,
): number | null {
  const { action0, actionCount } = welcomeCardGeometry(termRows, chromeRows, compact);
  const index = clickRow1 - 1 - action0;
  if (index < 0 || index >= actionCount) return null;
  return index;
}
