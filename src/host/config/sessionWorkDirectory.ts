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
//
// 撞名占用（rework r2）：懒开后路径先记进会话行、盘上迟迟不出现，纯磁盘判定看不见
// 这些占用——两个同日同题会话会拿到同一路径，后写的一家把文件混进先写的一家的目录。
// 候选名判定改为「磁盘已有条目 ∪ 其它会话行已记下的 workingDirectory」（reservedPaths
// 由调用方从会话库取，见 sessionWorkDirectoryReservations）。运行开始前（agent preflight）
// 发现行内路径也被其它会话占用且盘上尚无内容时，maybeDivertCollidingSessionWorkDirectory
// 趁零数据损失改道到同基础名的下一个空闲后缀；盘上已有内容的路径不动（可能是本会话
// 早前轮次的产出，改道会把文件丢在旧目录）。
//
// 进程内占名（rework r3）：agent 回写会话行之前 reservedPaths 仍是空的，两个同时进来的
// 规划都会看见空盘、拿到同一条未落盘路径，后写的一家把文件混进先写的目录。findFree
// 在磁盘检查返回之后、再次 await 或 return 之前，同步把选中的绝对路径记进本进程占用集；
// 之后的 plan / replan / divert 把它当磁盘条目，哪怕占用列表过期、目录从未创建。
// 名字占到进程退出为止——调用方可能还没把路径写进会话行，这里不释放；烧掉一个没人
// 再用的名字可以接受。不在默认工作根下 mkdir、建锁文件。重规划只豁免本会话自己的
// 当前路径，且仅当本次搜索开始前本进程已经占住它（标题洗出来仍是这条路径时返回
// undefined，而不是 -2）；改道不豁免。
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
  /**
   * 已被占用的路径（其它会话行已记下、可能尚未落盘的规划路径）：与磁盘条目一样
   * 参与撞名判定。懒开后纯问答会话的路径永不落盘，只看磁盘会让两个会话共享目录。
   */
  reservedPaths?: readonly string[];
}

export interface ReplanSessionWorkDirectoryOptions {
  /** 会话行里持久化的工作目录（候选的懒规划路径） */
  workingDirectory: string;
  /** 会话当前标题；占位/缺失视为不可用，不重规划 */
  sessionTitle?: string;
  /** 首条用户消息；标题若只是它的降级截断（前缀 / 派生 / 以 `...` 结尾）则不重规划 */
  userMessage?: string;
  env?: NodeJS.ProcessEnv;
  /** 其它会话行已记下的占用路径；本会话自己的当前路径会自动从占用集中剔除 */
  reservedPaths?: readonly string[];
}

export interface DivertSessionWorkDirectoryOptions {
  /** 会话行里持久化的工作目录（疑似与其它会话撞名的规划路径） */
  workingDirectory: string;
  /** 其它会话行已记下的占用路径（不含本会话自己的） */
  reservedPaths: readonly string[];
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

/** 目录里已经有文件（或任何条目）＝有内容；不存在/为空/读不了都算没内容。 */
async function directoryHasContent(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** 占用集：解析到绝对路径后只留默认工作根之内的（之外的永远撞不到候选名）。 */
function resolveReservationSet(root: string, reservedPaths: readonly string[] | undefined): Set<string> {
  const reserved = new Set<string>();
  for (const raw of reservedPaths ?? []) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    if (isPathWithinRoot(resolved, root)) reserved.add(resolved);
  }
  return reserved;
}

/**
 * 本进程已经交给调用方、但会话行可能还没写下、目录也可能永远不建的路径。
 * 只在内存里占名，不创建任何目录或锁文件。不释放：回写落在调用方，这里无法证明
 * 会话行已经不再记录它；进程退出即清空。
 */
const claimedSessionWorkDirectories = new Set<string>();

interface SessionWorkDirectoryClaimExemption {
  /** 重规划可以保住的那条当前路径（绝对路径） */
  path: string;
  /** 本次搜索开始前，本进程的占用集里已经有它（本会话早前的规划） */
  heldAtStart: boolean;
}

function candidateIsTaken(
  resolved: string,
  reserved: Set<string>,
  exemption: SessionWorkDirectoryClaimExemption | undefined,
): boolean {
  const heldByThisReplan = exemption?.heldAtStart === true && exemption.path === resolved;
  const claimedByOthers = claimedSessionWorkDirectories.has(resolved) && !heldByThisReplan;
  return reserved.has(resolved) || claimedByOthers;
}

async function findFreeSessionWorkDirectory(
  root: string,
  baseName: string,
  reserved: Set<string>,
  exemptPath?: string,
): Promise<string> {
  // 豁免快照必须在第一次 await 之前取：搜索进行中被别的规划器占走的路径不算「自己的」。
  const exemptResolved = exemptPath === undefined ? undefined : path.resolve(exemptPath);
  const exemption: SessionWorkDirectoryClaimExemption | undefined = exemptResolved === undefined
    ? undefined
    : { path: exemptResolved, heldAtStart: claimedSessionWorkDirectories.has(exemptResolved) };
  for (let attempt = 1; attempt <= COLLISION_SUFFIX_LIMIT; attempt++) {
    const candidate = path.join(root, attempt === 1 ? baseName : `${baseName}-${attempt}`);
    const resolved = path.resolve(candidate);
    if (candidateIsTaken(resolved, reserved, exemption)) continue;
    if (await existsOnDisk(resolved)) continue;
    // stat 回来之后到占名之间没有 await。两个规划器可以同时看见空盘，
    // 但先恢复的那个同步占名，后恢复的复检会把它当成已占用。
    if (candidateIsTaken(resolved, reserved, exemption)) continue;
    claimedSessionWorkDirectories.add(resolved);
    return candidate;
  }
  throw new Error(`session work directory name exhausted after ${COLLISION_SUFFIX_LIMIT} collisions: ${baseName}`);
}

/**
 * 规划（不落盘）无文件夹新会话的按会话产出目录路径
 * `<getDefaultWorkDirectory()>/任务_MMDD_<标题>`（英文 UI `Task_MMDD_<标题>`）。
 *
 * 撞名后缀按「磁盘已有条目 ∪ 其它会话行已记下的路径（reservedPaths）∪ 本进程
 * 已经发出去、尚未落盘的路径」判定。懒开后路径先记进会话行、纯问答会话的目录
 * 永不落盘；回写会话行之前占用列表也还是空的，只看磁盘会让同时进来的两个会话
 * 拿到同一路径（rework r2 / r3）。连根目录都还没建时第一个候选即中。本函数不做
 * 任何写盘动作——纯问答会话因此一个目录都不会建出来（N-DELIVERABLE-WORKDIR-LAZY），
 * 落盘交给 materializeSessionWorkDirectory。
 */
export async function planSessionWorkDirectory(
  options: SessionWorkDirectoryOptions = {},
): Promise<string> {
  const root = getDefaultWorkDirectory(options.env);
  const baseName = buildSessionFolderBaseName(options);
  return findFreeSessionWorkDirectory(root, baseName, resolveReservationSet(root, options.reservedPaths));
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
 * 重规划同样避开 reservedPaths 和本进程占用集（自己的当前路径除外：只豁免
 * 搜索开始前已经占住的那条，改道路径不走这个豁免）。
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
  const currentResolved = path.resolve(current);
  const reservedForReplan = (options.reservedPaths ?? []).filter(
    (candidate) => candidate.trim() && path.resolve(candidate) !== currentResolved,
  );
  const replanned = await findFreeSessionWorkDirectory(
    root,
    buildSessionFolderBaseName({ sessionTitle: title, env: options.env }),
    resolveReservationSet(root, reservedForReplan),
    currentResolved,
  );
  return path.resolve(replanned) === currentResolved ? undefined : replanned;
}

/** 路径是否本模块规划出的按会话产出目录（默认工作根之内、严格小于根、任务_/Task_ 形状）。 */
export function isPlannedSessionWorkDirectory(dir: string, env?: NodeJS.ProcessEnv): boolean {
  const trimmed = dir.trim();
  if (!trimmed) return false;
  const root = getDefaultWorkDirectory(env);
  const resolved = path.resolve(trimmed);
  if (resolved === path.resolve(root) || !isPathWithinRoot(resolved, root)) return false;
  return PLANNED_FOLDER_NAME_PATTERN.test(path.basename(resolved));
}

/**
 * 撞名改道（rework r2）：会话行记下的规划路径同时被其它会话行记下（规划期竞态的
 * 残留——旧判定只看磁盘，纯问答会话的路径永不落盘），且盘上还没有任何内容
 * （目录不存在或为空）时，趁零数据损失改道到同基础名的下一个空闲后缀，由调用方
 * 回写会话。以下任一情况直接返回 undefined：路径不是本模块规划的形状；不在默认
 * 工作根之内；没有其它会话占用；盘上已有内容（可能是本会话早前轮次的产出，改道
 * 会把文件丢在旧目录）；没有可用的空闲名。改道不豁免当前路径：本进程占用集和
 * reservedPaths 里的同名都算占用，空闲名从下一个后缀起。
 */
export async function maybeDivertCollidingSessionWorkDirectory(
  options: DivertSessionWorkDirectoryOptions,
): Promise<string | undefined> {
  const current = options.workingDirectory.trim();
  if (!current || !isPlannedSessionWorkDirectory(current, options.env)) return undefined;
  const root = getDefaultWorkDirectory(options.env);
  const currentFolderName = path.basename(current);
  const reserved = resolveReservationSet(root, options.reservedPaths);
  if (!reserved.has(path.resolve(current))) return undefined;
  if (await directoryHasContent(current)) return undefined;
  const baseName = currentFolderName.replace(/-\d+$/, '');
  const diverted = await findFreeSessionWorkDirectory(root, baseName, reserved);
  return path.resolve(diverted) === path.resolve(current) ? undefined : diverted;
}
