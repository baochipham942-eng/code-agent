// ============================================================================
// 无文件夹会话的按会话产出目录（N-DELIVERABLE-WORKDIR-DEFAULT）
// ============================================================================
// 没绑定项目文件夹的会话（快速对话等）此前所有产物共用同一个扁平默认目录
// （getDefaultWorkDirectory()，通常 ~/Neo），全堆在一层。本模块在新会话首轮为它
// 在该目录下开一个自己的可见子目录：任务_MMDD_<标题>（英文 UI Task_MMDD_<标题>）。
// 只创建、永不删除/改名；标题洗掉文件系统非法字符，撞名追加 -2/-3 后缀。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getConfigService } from '../services/core/configService';
import { isPlaceholderSessionTitle } from '../../shared/sessionTitlePlaceholder';
import { getDefaultWorkDirectory } from './configPaths';

export interface SessionWorkDirectoryOptions {
  /** 会话标题；占位标题（「新对话」等）视为没有标题 */
  sessionTitle?: string;
  /** 首条用户消息；没有可用标题时取前 20 字符当目录名 */
  userMessage?: string;
  /** 目录名里的 MMDD 取这个时间戳（缺省 Date.now()），本地时区 */
  now?: number;
  /** 语言档：zh → 任务_ 前缀，en → Task_ 前缀；缺省读 ui.language，读失败按 zh */
  language?: 'zh' | 'en';
  env?: NodeJS.ProcessEnv;
}

const TITLE_MAX_CHARS = 40;
const USER_MESSAGE_TITLE_CHARS = 20;
/** 撞名后缀封顶：-2 … -100 全撞说明目录名生成已病态，抛错走调用方兜底 */
const COLLISION_SUFFIX_LIMIT = 100;

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

/** 洗目录名：去非法字符与控制符、去前导点、折叠空白、截 40 字符。洗完为空返回 undefined。 */
function sanitizeFolderTitle(raw: string): string | undefined {
  const stripped = raw.replace(ILLEGAL_FOLDER_CHARS, '').replace(/^\.+/, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  const capped = Array.from(collapsed)
    .slice(0, TITLE_MAX_CHARS)
    .join('')
    // 截断可能留下尾空白/尾点（Windows 目录名不允许），一并收掉
    .replace(/[\s.]+$/, '');
  return capped || undefined;
}

function buildSessionFolderBaseName(options: SessionWorkDirectoryOptions): string {
  const date = new Date(options.now ?? Date.now());
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const prefix = (options.language ?? readUiLanguage()) === 'en' ? 'Task' : '任务';
  const title = sanitizeFolderTitle(usableSessionTitle(options.sessionTitle) ?? '')
    ?? sanitizeFolderTitle(
      Array.from(options.userMessage ?? '')
        .slice(0, USER_MESSAGE_TITLE_CHARS)
        .join(''),
    )
    ?? 'untitled';
  return `${prefix}_${mmdd}_${title}`;
}

/**
 * 创建并返回无文件夹新会话的按会话产出目录
 * `<getDefaultWorkDirectory()>/任务_MMDD_<标题>`（英文 UI `Task_MMDD_<标题>`）。
 *
 * 只创建目录，绝不删除或改名既有内容。根目录 recursive 确保后，叶子用非递归 mkdir
 * 原子创建：已存在（EEXIST）时依次尝试 `-2`、`-3`… 后缀。
 */
export async function createSessionWorkDirectory(
  options: SessionWorkDirectoryOptions = {},
): Promise<string> {
  const root = getDefaultWorkDirectory(options.env);
  await fs.mkdir(root, { recursive: true });

  const baseName = buildSessionFolderBaseName(options);
  for (let attempt = 1; attempt <= COLLISION_SUFFIX_LIMIT; attempt++) {
    const candidate = path.join(root, attempt === 1 ? baseName : `${baseName}-${attempt}`);
    try {
      await fs.mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`session work directory name exhausted after ${COLLISION_SUFFIX_LIMIT} collisions: ${baseName}`);
}
