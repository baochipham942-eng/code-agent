// ============================================================================
// 无文件夹会话的按会话产出目录（N-DELIVERABLE-WORKDIR-DEFAULT / N-DELIVERABLE-WORKDIR-LAZY）
// ============================================================================
// 没绑定项目文件夹的会话（快速对话等）此前所有产物共用同一个扁平默认目录
// （getDefaultWorkDirectory()，通常 ~/Neo），全堆在一层。本模块在新会话首轮为它
// 在该目录下规划一个自己的可见子目录：任务_MMDD_<标题>（英文 UI Task_MMDD_<标题>）。
//
// 懒开（N-DELIVERABLE-WORKDIR-LAZY）：首轮只规划不落盘（planSessionWorkDirectory），
// 纯问答会话不产生任何目录；首个非只读工具派发前才补 mkdir
// （materializeSessionWorkDirectory，幂等）。目录只创建、永不删除/改名；标题洗掉
// 文件系统非法字符，撞名追加 -2/-3 后缀。首轮智能标题还没算完，目录名回退到
// 首条用户消息的第一个分句；标题就位后目录仍未落盘时，可按标题重规划一次
// （maybeReplanSessionWorkDirectory），盘上零改动。标题本身也先按分句切再截 40 字
// （截断停在分句/词边界）；降级标题（消息前缀 / 以 `...` 结尾）不重规划。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getConfigService } from '../services/core/configService';
import { isPlaceholderSessionTitle } from '../../shared/sessionTitlePlaceholder';
import { getDefaultWorkDirectory } from './configPaths';
import { isPathWithinRoot } from '../runtime/workspaceScope';

export interface SessionWorkDirectoryOptions {
  /** 会话标题；占位标题（「新对话」等）视为没有标题 */
  sessionTitle?: string;
  /** 首条用户消息；没有可用标题时取第一个分句当目录名（不再拦腰截断句子） */
  userMessage?: string;
  /** 目录名里的 MMDD 取这个时间戳（缺省 Date.now()），本地时区 */
  now?: number;
  /** 语言档：zh → 任务_ 前缀，en → Task_ 前缀；缺省读 ui.language，读失败按 zh */
  language?: 'zh' | 'en';
  env?: NodeJS.ProcessEnv;
}

export interface ReplanSessionWorkDirectoryOptions {
  /** 会话行里持久化的工作目录（候选的懒规划路径） */
  workingDirectory: string;
  /** 会话当前标题；占位/缺失视为不可用，不重规划 */
  sessionTitle?: string;
  /** 首条用户消息；标题若只是它的降级截断（前缀 / 派生 / 以 `...` 结尾）则不重规划 */
  userMessage?: string;
  env?: NodeJS.ProcessEnv;
}

const TITLE_MAX_CHARS = 40;
/** 撞名后缀封顶：-2 … -100 全撞说明目录名生成已病态，抛错走调用方兜底 */
const COLLISION_SUFFIX_LIMIT = 100;

/** 分句符：目录名到第一个句读/换行即止，不把句子拦腰截断（。！？.!?；;，,与换行） */
const CLAUSE_DELIMITERS = /[。！？.!?；;，,\n]/;

/** 本模块规划出的目录名形状（任务_MMDD_ / Task_MMDD_）。重规划只认这个形状。 */
const PLANNED_FOLDER_NAME_PATTERN = /^(任务|Task)_\d{4}_/;

/** Windows/macOS 文件名非法字符 + 控制字符（任务书口径：/ \ : * ? " < > | 与控制符） */
// eslint-disable-next-line no-control-regex -- 控制字符正是要剥离的目标，不是误写
const ILLEGAL_FOLDER_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/** UI 语言跟随用户设置（ui.language）；读取失败按中文兜底，目录创建不许被设置读取炸掉。 */
function readUiLanguage(): 'zh' | 'en' {
  try {
    return getConfigService().getSettings().ui.language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

function usableSessionTitle(sessionTitle: string | undefined): string | undefined {
  const trimmed = sessionTitle?.trim();
  if (!trimmed || isPlaceholderSessionTitle(trimmed)) return undefined;
  return trimmed;
}

/** 第一个分句：到第一个句读/换行即止（整句没有分句符则取整句）。 */
function firstClause(text: string): string {
  return text.split(CLAUSE_DELIMITERS)[0] ?? '';
}

/**
 * 40 字上限停在窗口内最后一个分句符，没有分句符则停在最后一个空白（完整词）；
 * 都没有才硬切。截断可能留下尾空白/尾点（Windows 目录名不允许），一并收掉。
 */
function capFolderTitle(text: string): string {
  const chars = Array.from(text);
  const window = chars.length <= TITLE_MAX_CHARS
    ? text
    : chars.slice(0, TITLE_MAX_CHARS).join('');
  if (chars.length > TITLE_MAX_CHARS) {
    let lastClause = -1;
    const windowChars = Array.from(window);
    for (let i = 0; i < windowChars.length; i++) {
      const ch = windowChars[i];
      if (ch !== undefined && CLAUSE_DELIMITERS.test(ch)) lastClause = i;
    }
    if (lastClause > 0) {
      const cut = windowChars.slice(0, lastClause).join('').replace(/[\s.]+$/, '');
      if (cut) return cut;
    }
    const lastSpace = window.lastIndexOf(' ');
    if (lastSpace > 0) {
      const cut = window.slice(0, lastSpace).replace(/[\s.]+$/, '');
      if (cut) return cut;
    }
  }
  return window.replace(/[\s.]+$/, '');
}

/** 洗目录名：去前导点后再取第一个分句，再去非法字符与控制符、折叠空白、按边界截 40 字符。洗完为空返回 undefined。 */
function sanitizeFolderTitle(raw: string): string | undefined {
  // 前导点先剥掉，避免 `..foo` 被 `.` 分句符切成空串；句中 `.` 仍按分句切。
  const prepared = raw.trim().replace(/^\.+/, '');
  const clause = firstClause(prepared);
  const stripped = clause.replace(ILLEGAL_FOLDER_CHARS, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  const capped = capFolderTitle(collapsed);
  return capped || undefined;
}

/**
 * 降级标题（小模型不可用时 deriveFallbackSessionTitle 的产物）不是人话摘要：
 * 以 `...` 结尾，或只是首条消息的前缀/派生。此时首轮分句名已经更好，不重规划。
 */
function isDegradedFallbackTitle(
  title: string,
  options: { userMessage?: string; currentFolderName: string },
): boolean {
  const trimmed = title.trim();
  if (trimmed.endsWith('...')) return true;

  const message = options.userMessage?.trim();
  if (message) {
    const firstLine = message.split('\n')[0] ?? '';
    if (message.startsWith(trimmed) || firstLine.startsWith(trimmed)) return true;
    const firstLinePrefix = Array.from(firstLine).slice(0, 50).join('');
    if (trimmed === firstLinePrefix || trimmed === `${firstLinePrefix}...`) return true;
  }

  const currentTitlePart = options.currentFolderName
    .replace(PLANNED_FOLDER_NAME_PATTERN, '')
    .replace(/-\d+$/, '');
  return Boolean(
    currentTitlePart
    && trimmed.startsWith(currentTitlePart)
    && trimmed.length > currentTitlePart.length,
  );
}

function buildSessionFolderBaseName(options: SessionWorkDirectoryOptions): string {
  const date = new Date(options.now ?? Date.now());
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const prefix = (options.language ?? readUiLanguage()) === 'en' ? 'Task' : '任务';
  const title = sanitizeFolderTitle(usableSessionTitle(options.sessionTitle) ?? '')
    ?? sanitizeFolderTitle(options.userMessage ?? '')
    ?? 'untitled';
  return `${prefix}_${mmdd}_${title}`;
}

async function existsOnDisk(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 规划（不落盘）无文件夹新会话的按会话产出目录路径
 * `<getDefaultWorkDirectory()>/任务_MMDD_<标题>`（英文 UI `Task_MMDD_<标题>`）。
 *
 * 撞名后缀按磁盘现状判定：已存在的条目依次试 `-2`、`-3`…；连根目录都还没建时
 * 第一个候选即中。本函数不做任何写盘动作——纯问答会话因此一个目录都不会建出来
 * （N-DELIVERABLE-WORKDIR-LAZY），落盘交给 materializeSessionWorkDirectory。
 */
export async function planSessionWorkDirectory(
  options: SessionWorkDirectoryOptions = {},
): Promise<string> {
  const root = getDefaultWorkDirectory(options.env);
  const baseName = buildSessionFolderBaseName(options);
  for (let attempt = 1; attempt <= COLLISION_SUFFIX_LIMIT; attempt++) {
    const candidate = path.join(root, attempt === 1 ? baseName : `${baseName}-${attempt}`);
    if (!(await existsOnDisk(candidate))) return candidate;
  }
  throw new Error(`session work directory name exhausted after ${COLLISION_SUFFIX_LIMIT} collisions: ${baseName}`);
}

/**
 * 把规划出的目录真正建出来：recursive mkdir，幂等（已存在不报错、不动内容）。
 * 只创建、绝不删除或改名既有内容。
 */
export async function materializeSessionWorkDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * 智能标题就位后的改名收口（N-DELIVERABLE-WORKDIR-LAZY）：首轮规划名用的是首条
 * 消息的第一个分句（智能标题要几十秒后才落库）。目录仍未落盘且标题可用时，按标题
 * 重新规划，由调用方回写会话——盘上零改动。以下任一情况直接返回 undefined（什么都不用做）：
 * 标题不可用；标题只是首条消息的降级截断（前缀/派生/以 `...` 结尾）；路径不是本模块
 * 规划的形状；不在默认工作根之内（含根本身）；目录已落盘；按标题重规划出来的路径没有变化。
 */
export async function maybeReplanSessionWorkDirectory(
  options: ReplanSessionWorkDirectoryOptions,
): Promise<string | undefined> {
  const title = usableSessionTitle(options.sessionTitle);
  const current = options.workingDirectory.trim();
  if (!title || !current) return undefined;
  const currentFolderName = path.basename(current);
  if (!PLANNED_FOLDER_NAME_PATTERN.test(currentFolderName)) return undefined;
  if (isDegradedFallbackTitle(title, {
    userMessage: options.userMessage,
    currentFolderName,
  })) return undefined;
  const root = getDefaultWorkDirectory(options.env);
  if (!isPathWithinRoot(current, root) || path.resolve(current) === path.resolve(root)) return undefined;
  if (await existsOnDisk(current)) return undefined;
  const replanned = await planSessionWorkDirectory({ sessionTitle: title, env: options.env });
  return path.resolve(replanned) === path.resolve(current) ? undefined : replanned;
}
