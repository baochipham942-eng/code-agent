// ============================================================================
// Slot data-dir isolation — default-deny reads of other CODE_AGENT_HOME slots
// ============================================================================
// 槽的存在意义就是隔离。folder-trust 管的是「工作目录可不可信」，不管
// 「另一个槽的私有数据目录能不能读」。这里拦的是后者。
//
// 判据不按名字枚举（.code-agent-dev / .code-agent-chatprobe …）：新开一个槽就漏一个。
// 家族 = home 下以 CONFIG_DIR_NEW 为前缀的直接子目录；不是当前 getUserConfigDir()
// 的，就是别人的。
//
// 真正读到文件的时刻，路径可以和入口不一样：
// - Bash 的 cd 会改后续命令的 cwd（子 shell 里的 cd 不越出括号）
// - Glob ** / Grep -r 会从允许的入口走进别人的槽根；Glob/Grep 工具边遍历边排除，
//   Bash 里的递归命令（grep -r / rg / find / fd）改不了排除项，起点覆盖别人槽根时整条拒
// - 软链会让字面路径和真实路径分离：放行要求字面与真实路径都属于当前槽，
//   任一命中别人的槽就拒；realpath 仍要做（防 ~/x/../.code-agent）。
//
// Bash 命令的段/词/cd 传播一律取自共享解析器 parseShellCommand（commandParse.ts），
// 不再手写拆分。解析失败 / 有 uncertain 时按 ADR-065 的姿势 fail-closed：
// 枚举只会变宽（lenient 全词 + 全部可能基准 + 家族名兜底），绝不因为解析失败交空清单。
// ============================================================================

import { readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHomeDir, getUserConfigDir } from '../config/configPaths';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { lenientCommandWords, listTerminatorAfter, parseShellCommand } from './commandParse';
import type { SegmentTerminator } from './commandParse';
import { CONFIG_DIR_NEW } from '../../shared/constants/configDir';

export const FOREIGN_SLOT_DATA_DIR_CODE = 'FOREIGN_SLOT_DATA_DIR';

/** 显式允许跨槽读取。仅评测/诊断用，取值 `'1'` 才放行。 */
export const CROSS_SLOT_READ_ALLOW_ENV = 'CODE_AGENT_ALLOW_CROSS_SLOT_READ';

/** 逗号分隔的允许跨槽读取的数据目录绝对路径白名单。 */
export const CROSS_SLOT_READ_ALLOWLIST_ENV = 'CODE_AGENT_CROSS_SLOT_READ_ALLOWLIST';

export type SlotDataDirAccess =
  | { allowed: true }
  | {
    allowed: false;
    reason: string;
    slotName: string;
    slotRoot: string;
    candidatePath: string;
  };

export interface SlotDataDirGuardOptions {
  currentDataDir?: string;
  homeDirs?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface ForeignSlotTraversalExcludes {
  /** 字面槽根 + 真实槽根，供结果侧做前缀过滤（不逐文件 realpath）。 */
  roots: string[];
  /** 相对搜索根的 glob ignore，给 Glob / rg --glob 用。 */
  ignoreGlobs: string[];
  /** 目录名，给系统 grep --exclude-dir 用。 */
  excludeDirNames: string[];
}

interface FamilySlot {
  name: string;
  lexicalRoot: string;
  canonicalRoot: string;
}

interface SlotGuardContext {
  env: NodeJS.ProcessEnv;
  currentLexical: string;
  currentCanonical: string;
  homeDirs: string[];
  familySlots: FamilySlot[];
}

function lexicalPath(input: string): string {
  return path.resolve(input);
}

function canonicalize(input: string): string {
  const kernelStyle = resolveKernelStyle(input);
  if (kernelStyle) return kernelStyle;
  const resolved = path.resolve(input);
  try {
    return resolveCanonicalRunPath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 内核打开文件的语义是「逐组件解析软链，`..` 作用于已解析前缀」；path.resolve
 * 先把 `..` 词法塌缩掉，`<软链>/../x` 会被算进软链的词法父目录、恰好躲开真身
 * 所在的槽（R3①）。含 `..` 的路径改用 realpath 按内核语义定身；解析不了
 * （路径不存在等）返回 null，调用方退回词法解析——读不到的路径没有泄露面。
 */
function resolveKernelStyle(candidate: string): string | null {
  if (!/(^|\/)\.\.(\/|$)/.test(candidate)) return null;
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function isSameOrChild(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueLexical(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const resolved = lexicalPath(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function unquote(word: string): string {
  const first = word[0];
  if ((first === "'" || first === '"') && word.length >= 2 && word.at(-1) === first) {
    return word.slice(1, -1);
  }
  return word;
}

function expandHomePrefix(raw: string, homeDir: string): string {
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return path.join(homeDir, raw.slice(2));
  if (raw === '$HOME' || raw === '${HOME}') return homeDir;
  if (raw.startsWith('$HOME/')) return path.join(homeDir, raw.slice('$HOME/'.length));
  if (raw.startsWith('${HOME}/')) return path.join(homeDir, raw.slice('${HOME}/'.length));
  return raw;
}

function globLiteralPrefix(pattern: string): string {
  let prefix = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' || char === '?' || char === '[' || char === '{') break;
    prefix += char;
  }
  return prefix.replace(/\/+$/, '');
}

function looksLikePath(word: string): boolean {
  if (!word) return false;
  if (word.startsWith('-')) return false;
  if (word === '~' || word.startsWith('~/') || word.startsWith('/') || word.startsWith('./') || word.startsWith('../')) {
    return true;
  }
  if (word.startsWith('$HOME') || word.startsWith('${HOME}')) return true;
  if (word.includes(path.sep) || word.includes('/')) return true;
  return word.startsWith(CONFIG_DIR_NEW);
}

function isPathLikeParamKey(key: string, toolName: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (normalized.includes('path') || normalized.includes('directory') || normalized.includes('file')) {
    return true;
  }
  return normalizeGlobTool(toolName) && normalized === 'pattern';
}

function normalizeGlobTool(toolName: string): boolean {
  return toolName.trim().toLowerCase() === 'glob';
}

function isBashTool(toolName: string): boolean {
  return toolName.trim().toLowerCase() === 'bash';
}

function isGrepTool(toolName: string): boolean {
  return toolName.trim().toLowerCase() === 'grep';
}

function isListDirectoryTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === 'listdirectory' || normalized === 'ls';
}

// ----------------------------------------------------------------------------
// Bash 递归遍历命令识别与搜索根提取
// ----------------------------------------------------------------------------

const GREP_FAMILY_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'zgrep']);
const ALWAYS_RECURSIVE_PROGRAMS = new Set(['rg', 'ripgrep', 'find', 'fd', 'fdfind']);

type RecursiveTraversalKind = 'grep' | 'always';

function programBasename(word: string): string {
  return word.split('/').pop() ?? '';
}

/** grep 系要 -r/-R（或 -d recurse）才递归；rg/find/fd 默认就整棵遍历。 */
function recursiveTraversalKind(words: string[]): RecursiveTraversalKind | null {
  const start = skipCommandWrapper(words);
  const program = programBasename(words[start] ?? '');
  if (GREP_FAMILY_PROGRAMS.has(program)) {
    const args = words.slice(start + 1);
    let recursive = args.some((arg) => (
      arg === '-r'
      || arg === '-R'
      || arg === '--recursive'
      || (/^-[^-]+$/.test(arg) && /[rR]/.test(arg.slice(1)))
      || /^-d(recurse|dereference)$/.test(arg)
      || /^--directories=(recurse|dereference)$/.test(arg)
    ));
    for (let index = 0; index < args.length - 1; index += 1) {
      if ((args[index] === '-d' || args[index] === '--directories')
        && /^(recurse|dereference)$/.test(args[index + 1])) {
        recursive = true;
      }
    }
    return recursive ? 'grep' : null;
  }
  return ALWAYS_RECURSIVE_PROGRAMS.has(program) ? 'always' : null;
}

/** 这些 flag 的下一个词是值（模式/模式文件/排除项），不是搜索根。 */
const TRAVERSAL_VALUE_FLAGS = new Set([
  '-e', '-f', '-d', '-m', '--regexp', '--file', '--directories',
  '--exclude', '--exclude-dir', '--exclude-from', '--include',
  '-g', '--glob',
]);
/** 提供了模式的 flag：出现后位置参数里不再有 pattern 位（R4②：-f/--file 从文件读模式，同样顶掉 pattern 位，否则真实的递归搜索根会被当成 pattern 删掉）。 */
const TRAVERSAL_PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file']);
/** 值本身是被读文件的 flag：值要进路径候选（读模式文件也是读）。 */
const TRAVERSAL_READ_VALUE_FLAGS = new Set(['-f', '--file', '--exclude-from']);

/**
 * 递归遍历命令的搜索根：位置参数（扣掉 pattern 位）按 cwd 解析成绝对路径；
 * 一个位置参数都没有就以 cwd 为根（grep -r x / find -name y 都从 cwd 起遍历）。
 * readOperands 是 flag 值里被真实读取的文件（-f 模式文件等）。
 */
function extractTraversalRoots(
  words: string[],
  cwd: string,
  homeDir: string,
  kind: RecursiveTraversalKind,
): { roots: string[]; readOperands: string[] } {
  const start = skipCommandWrapper(words);
  const program = programBasename(words[start] ?? '');
  const args = words.slice(start + 1);
  const positionals: string[] = [];
  const readOperands: string[] = [];
  let skipNextValue = false;
  let explicitPattern = false;
  let filesOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (skipNextValue) {
      skipNextValue = false;
      continue;
    }
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (program === 'find') {
        if (arg === '-H' || arg === '-L' || arg === '-P') continue;
        break; // 进入 find 表达式区，后面不再是路径
      }
      if (TRAVERSAL_PATTERN_FLAGS.has(arg)) explicitPattern = true;
      if (arg.startsWith('--regexp=') || arg.startsWith('--file=')) {
        explicitPattern = true;
        if (arg.startsWith('--file=')) {
          readOperands.push(resolveCandidate(arg.slice('--file='.length), cwd, homeDir));
        }
        continue;
      }
      if (TRAVERSAL_VALUE_FLAGS.has(arg)) {
        skipNextValue = true;
        if (TRAVERSAL_READ_VALUE_FLAGS.has(arg)) {
          const value = args[index + 1];
          if (value !== undefined && !value.startsWith('-')) {
            readOperands.push(resolveCandidate(value, cwd, homeDir));
          }
        }
      }
      if (arg === '--files') filesOnly = true;
      continue;
    }
    positionals.push(arg);
  }

  // 第一个位置参数是 pattern（grep/rg/fd），不是搜索根；显式 -e/-f 或 --files 时没有 pattern 位。
  const dropPattern = (kind === 'grep' || program === 'rg' || program === 'fd')
    && !explicitPattern && !filesOnly;
  const rootArgs = dropPattern && positionals.length > 0 ? positionals.slice(1) : positionals;
  const roots = rootArgs.length === 0
    ? [lexicalPath(cwd)]
    : rootArgs.map((raw) => resolveCandidate(raw, cwd, homeDir));
  return { roots, readOperands };
}

function resolveCandidate(raw: string, workingDirectory: string, homeDir: string): string {
  const expanded = expandHomePrefix(raw, homeDir);
  // 不能用 path.join 拼 cwd 与相对路径：它会把 .. 词法塌缩掉，<软链>/../x 提前变成
  // 软链的词法父目录、恰好躲开内核序（先解软链再走 ..）的 realpath 定身（R4①）。
  // 字符串拼接保留 ..，交给 resolveKernelStyle 按内核语义解析；
  // 解析不了（路径不存在等）再退回词法 resolve——读不到的路径没有泄露面。
  const joined = path.isAbsolute(expanded)
    ? expanded
    : `${workingDirectory}/${expanded}`;
  return resolveKernelStyle(joined) ?? lexicalPath(joined);
}

function extractEmbeddedFamilyMentions(text: string): string[] {
  const mentions: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(CONFIG_DIR_NEW, searchFrom);
    if (index < 0) break;
    searchFrom = index + CONFIG_DIR_NEW.length;
    let start = index;
    while (start > 0 && !/[\s'"`;|&<>(){}]/.test(text[start - 1])) start -= 1;
    let end = index + CONFIG_DIR_NEW.length;
    while (end < text.length && !/[\s'"`;|&<>(){}]/.test(text[end])) end += 1;
    const mention = text.slice(start, end);
    if (mention) mentions.push(mention);
  }
  return mentions;
}

const CWD_COMMANDS = new Set(['cd', 'pushd', 'popd']);

function skipCommandWrapper(words: string[]): number {
  // '{' 是保留字分组前缀（`{ cd X; }`），不剥离会让段首 cd/遍历命令识别不到。
  if (words[0] === 'builtin' || words[0] === 'command' || words[0] === '{') return 1;
  return 0;
}

function isCwdCommand(words: string[]): boolean {
  return CWD_COMMANDS.has(words[skipCommandWrapper(words)] ?? '');
}

function resolveCdTarget(words: string[], cwd: string, homeDir: string): string | null {
  const start = skipCommandWrapper(words);
  const program = words[start];
  if (program === 'popd') return null;
  const args = words.slice(start + 1);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === '-') return null;
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  if (positional.length === 0) return homeDir;
  return resolveCandidate(positional[0], cwd, homeDir);
}

/** 词表里像路径的词 → 候选绝对路径。词来自解析器（已去引号）。 */
function pathWordCandidates(words: string[], cwd: string, homeDir: string): string[] {
  const candidates: string[] = [];
  for (const word of words) {
    if (!looksLikePath(word)) continue;
    candidates.push(resolveCandidate(word, cwd, homeDir));
  }
  return candidates;
}

const SHELL_SCRIPT_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'dash']);
const SHELL_SCRIPT_VALUE_OPTIONS = new Set(['--rcfile', '--init-file', '-o', '+o', '-O', '+O']);

/** bash/sh/zsh/dash -c 的内层脚本（与 commandParse 的同判）；脚本文件操作数返回 null（内容不可枚举）。 */
function shellScriptOperand(words: string[]): string | null {
  const start = skipCommandWrapper(words);
  const program = programBasename(words[start] ?? '');
  if (!SHELL_SCRIPT_PROGRAMS.has(program)) return null;
  const args = words.slice(start + 1);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--' || !arg.startsWith('-') || arg === '-') return null;
    if (SHELL_SCRIPT_VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === '-c' || /^-[^-]*c[^-]*$/.test(arg)) return args[index + 1] ?? null;
  }
  return null;
}

/** eval 的内层脚本；无参数返回 null。 */
function evalScriptOperand(words: string[]): string | null {
  const start = skipCommandWrapper(words);
  if (programBasename(words[start] ?? '') !== 'eval') return null;
  const args = words.slice(start + 1);
  return args.length === 0 ? null : args.join(' ');
}

/**
 * cd 段是否会把父 shell 的 cwd 挪走：`;`/`&&`/换行/收尾的 standalone 段才会；
 * `&` 把整个 list 后台化、`|`/`|&` 的管道成员各自跑在子 shell 里，都不外溢
 * （与 permissionClassifier.contextAfterCdSegment 同判，语义真源在 commandParse 的
 * SegmentTerminator 注释）。
 */
function cdCarriesParentCwd(terminators: SegmentTerminator[], index: number): boolean {
  const own = terminators[index] ?? null;
  if (![null, ';', '&&', '||', '\n'].includes(own)) return false;
  if (['|', '|&'].includes(terminators[index - 1] ?? '')) return false;
  return listTerminatorAfter(terminators, index) !== '&';
}

const LENIENT_SEPARATOR_WORDS = new Set([
  ';', '&&', '||', '|', '|&', '&', '\n', '(', ')',
  '<', '>', '>>', '<<<', '<&', '>&', '>|',
]);

/** lenient 全词流按分隔符切成伪段，让 cd/遍历程序识别仍然成立。 */
function splitLenientSegments(words: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const word of words) {
    if (LENIENT_SEPARATOR_WORDS.has(word)) {
      segments.push([]);
      continue;
    }
    segments[segments.length - 1].push(word);
  }
  return segments.filter((segment) => segment.length > 0);
}

/**
 * 解析失败 / 有 uncertain 时的宽视图（ADR-065 姿势）：枚举只会变宽，绝不交空清单。
 * 基准 = 初始 cwd ∪ 家目录 ∪ 顺路收集到的每个 cd 目标（cd 目标按全部当前基准解析，
 * 嵌套子 shell 里相对 cd 链也能串起来）；词 = 解析中断前已切好的段 + lenient 全词流
 * + 裸文本家族目录名兜底（$(…) 内部等结构丢失时仍能咬住）。
 */
function collectBashCandidatesFailClosed(
  command: string,
  parsed: ReturnType<typeof parseShellCommand>,
  workingDirectory: string,
  homeDir: string,
): { candidates: string[]; traversalRoots: string[] } {
  const candidates: string[] = [];
  const traversalRoots: string[] = [];
  const bases = new Set<string>([workingDirectory, homeDir]);

  const absorb = (words: string[]): void => {
    if (words.length === 0) return;
    if (isCwdCommand(words)) {
      const targets = [...bases].map((base) => resolveCdTarget(words, base, homeDir));
      const resolved = targets.filter((entry): entry is string => entry !== null);
      candidates.push(...resolved);
      for (const target of resolved) bases.add(target);
      // cd 后 cwd 不可知：不收敛基准（全部保留，含家目录）。
    }
    const kind = recursiveTraversalKind(words);
    if (kind) {
      for (const base of [...bases]) {
        const traversal = extractTraversalRoots(words, base, homeDir, kind);
        traversalRoots.push(...traversal.roots);
        candidates.push(...traversal.readOperands);
      }
    }
    for (const base of [...bases]) {
      candidates.push(...pathWordCandidates(words, base, homeDir));
    }
  };

  // 解析中断前已经切好的段（reads/redirects 是词表外的路径候选）。
  for (const segment of parsed.segments) absorb(segment.words);
  for (const segment of parsed.segments) {
    for (const read of segment.reads) {
      for (const base of [...bases]) candidates.push(resolveCandidate(read.path, base, homeDir));
    }
    for (const redirect of segment.redirects) {
      for (const base of [...bases]) candidates.push(resolveCandidate(redirect.path, base, homeDir));
    }
  }
  // lenient 全词视图：shell-quote 还能看见的每个 token。
  for (const pseudo of splitLenientSegments(lenientCommandWords(command))) absorb(pseudo);
  // 裸文本里的家族目录名兜底。
  for (const mention of extractEmbeddedFamilyMentions(command)) {
    for (const base of [...bases]) candidates.push(resolveCandidate(mention, base, homeDir));
  }
  return { candidates, traversalRoots };
}

function collectBashCandidates(
  command: string,
  workingDirectory: string,
  homeDir: string,
): { candidates: string[]; traversalRoots: string[] } {
  const parsed = parseShellCommand(command);
  if (parsed.parsingFailed || parsed.uncertain.length > 0) {
    return collectBashCandidatesFailClosed(command, parsed, workingDirectory, homeDir);
  }

  const candidates: string[] = [];
  const traversalRoots: string[] = [];
  const terminators = parsed.segments.map((segment) => segment.terminator);
  const cwdBases = new Set<string>([workingDirectory]);
  const allBases = new Set<string>([workingDirectory]);
  let cwd = workingDirectory;
  let cwdKnown = true;

  for (const [index, segment] of parsed.segments.entries()) {
    const words = segment.words;
    const bases = cwdKnown ? [cwd] : [...cwdBases, homeDir];

    // 内层脚本（bash -c / eval）：同一进程语义，按当前 cwd 递归解析。
    // 内层解析失败时递归调用自己会走 fail-closed 宽视图。
    const script = shellScriptOperand(words) ?? evalScriptOperand(words);
    if (script !== null) {
      const inner = collectBashCandidates(script, cwd, homeDir);
      candidates.push(...inner.candidates);
      traversalRoots.push(...inner.traversalRoots);
      continue;
    }

    // 重定向读写两侧都是路径候选（解析器的词表里看不到它们）。
    for (const read of segment.reads) {
      for (const base of bases) candidates.push(resolveCandidate(read.path, base, homeDir));
    }
    for (const redirect of segment.redirects) {
      for (const base of bases) candidates.push(resolveCandidate(redirect.path, base, homeDir));
    }

    if (isCwdCommand(words)) {
      const targets = cwdKnown
        ? [resolveCdTarget(words, cwd, homeDir)]
        : [...cwdBases, homeDir].map((base) => resolveCdTarget(words, base, homeDir));
      const resolved = targets.filter((entry): entry is string => entry !== null);
      if (resolved.length === 0) {
        // cd -/popd 这类目标不可重构：cwd 未知，家目录入基准。
        cwdKnown = false;
        cwdBases.add(homeDir);
        allBases.add(homeDir);
        continue;
      }
      candidates.push(...resolved);
      const conditional = ['&&', '||'].includes(terminators[index - 1] ?? '');
      if (!cdCarriesParentCwd(terminators, index)) {
        // 子 shell/后台/管道里的 cd 不外溢：cwd 确定不变。
        // cd 目标只作候选（cd 进别人槽本身就是探路），不进基准——进了会让
        // 后续相对词按一个不可能的 cwd 解析，制造假阳性。
        continue;
      }
      for (const target of resolved) {
        cwdBases.add(target);
        allBases.add(target);
      }
      if (conditional || resolved.length > 1) {
        // &&/|| 后面的 cd 是否执行取决于前段退出码（R3③），或 cd 目标随基准多元：
        // 不能确定性地推进 cwd —— cwd 未知 + 基准并集，后续命令按全部可能基准检查。
        cwdKnown = false;
        continue;
      }
      cwd = resolved[0];
      continue;
    }

    // 递归遍历命令的入口 token 可以全然无害（$HOME），真正读进去的是遍历到的整棵树：
    // 收集遍历起点，交给 evaluateBashTraversalRoot 判「起点是否覆盖别人的槽根」。
    const kind = recursiveTraversalKind(words);
    if (kind) {
      for (const base of bases) {
        const traversal = extractTraversalRoots(words, base, homeDir, kind);
        traversalRoots.push(...traversal.roots);
        candidates.push(...traversal.readOperands);
      }
    }
    for (const base of bases) candidates.push(...pathWordCandidates(words, base, homeDir));
  }

  // 家族目录名兜底（裸文本扫描）：按出现过的全部基准（cwd 轨迹的并集，含初始 cwd）。
  for (const mention of extractEmbeddedFamilyMentions(command)) {
    for (const base of allBases) candidates.push(resolveCandidate(mention, base, homeDir));
    if (!cwdKnown) candidates.push(resolveCandidate(mention, homeDir, homeDir));
  }

  return { candidates, traversalRoots };
}

function collectToolPathCandidates(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
  homeDir: string = os.homedir(),
): { candidates: string[]; traversalRoots: string[] } {
  const candidates: string[] = [lexicalPath(workingDirectory)];
  let traversalRoots: string[] = [];
  // 工具参数是 JSON 裸串：引号剥离在这一层做（Bash 词来自解析器，已免引号）。
  const searchPath = typeof params.path === 'string' && params.path.trim()
    ? resolveCandidate(unquote(params.path), workingDirectory, homeDir)
    : lexicalPath(workingDirectory);

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!isPathLikeParamKey(key, toolName)) continue;
    candidates.push(resolveCandidate(unquote(value), workingDirectory, homeDir));
    if (normalizeGlobTool(toolName) && key.toLowerCase() === 'pattern') {
      const literal = globLiteralPrefix(unquote(value));
      if (literal) {
        const expanded = expandHomePrefix(literal, homeDir);
        candidates.push(
          path.isAbsolute(expanded)
            ? resolveCandidate(expanded, workingDirectory, homeDir)
            : lexicalPath(path.resolve(searchPath, expanded)),
        );
      }
    }
  }

  if (isBashTool(toolName) && typeof params.command === 'string') {
    const bashCwd = typeof params.working_directory === 'string' && params.working_directory.trim()
      ? resolveCandidate(unquote(params.working_directory), workingDirectory, homeDir)
      : lexicalPath(workingDirectory);
    const bash = collectBashCandidates(params.command, bashCwd, homeDir);
    candidates.push(...bash.candidates);
    traversalRoots = bash.traversalRoots;
  }

  return { candidates: uniqueLexical(candidates), traversalRoots };
}

function isRecursiveDiscoveryTool(toolName: string, params: Record<string, unknown>): boolean {
  if (isGrepTool(toolName)) return true;
  if (normalizeGlobTool(toolName)) {
    const pattern = typeof params.pattern === 'string' ? params.pattern : '';
    return pattern.includes('**') || pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
  }
  if (isListDirectoryTool(toolName)) {
    return params.recursive === true;
  }
  return false;
}

function discoverySearchRoot(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
  homeDir: string,
): string {
  if (typeof params.path === 'string' && params.path.trim()) {
    return resolveCandidate(unquote(params.path), workingDirectory, homeDir);
  }
  return lexicalPath(workingDirectory);
}

function crossSlotReadAllowed(slotRoot: string, env: NodeJS.ProcessEnv): boolean {
  if (env[CROSS_SLOT_READ_ALLOW_ENV]?.trim() === '1') return true;
  const raw = env[CROSS_SLOT_READ_ALLOWLIST_ENV]?.trim();
  if (!raw) return false;
  const allowed = raw.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean);
  const resolvedSlot = canonicalize(slotRoot);
  return allowed.some((entry) => canonicalize(entry) === resolvedSlot);
}

function listFamilySlots(homeDirs: string[]): FamilySlot[] {
  const slots: FamilySlot[] = [];
  const seen = new Set<string>();
  for (const home of homeDirs) {
    let names: string[];
    try {
      names = readdirSync(home);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(CONFIG_DIR_NEW)) continue;
      const lexicalRoot = path.join(home, name);
      if (seen.has(lexicalRoot)) continue;
      seen.add(lexicalRoot);
      slots.push({
        name,
        lexicalRoot,
        canonicalRoot: canonicalize(lexicalRoot),
      });
    }
  }
  return slots;
}

function inferredFamilySlot(candidateLexical: string, homeDirs: string[]): FamilySlot | null {
  for (const home of homeDirs) {
    if (!isSameOrChild(candidateLexical, home)) continue;
    const relative = path.relative(home, candidateLexical);
    const first = relative.split(path.sep).filter(Boolean)[0];
    if (!first?.startsWith(CONFIG_DIR_NEW)) continue;
    const lexicalRoot = path.join(home, first);
    return {
      name: first,
      lexicalRoot,
      canonicalRoot: canonicalize(lexicalRoot),
    };
  }
  return null;
}

function buildGuardContext(options: SlotDataDirGuardOptions = {}): SlotGuardContext {
  const env = options.env ?? process.env;
  const currentRaw = options.currentDataDir ?? getUserConfigDir();
  const homeDirs = uniqueLexical([
    ...(options.homeDirs ?? []),
    getHomeDir(),
    os.homedir(),
  ]);
  return {
    env,
    currentLexical: lexicalPath(currentRaw),
    currentCanonical: canonicalize(currentRaw),
    homeDirs,
    familySlots: listFamilySlots(homeDirs),
  };
}

function isCurrentSlot(slot: FamilySlot, ctx: SlotGuardContext): boolean {
  return slot.lexicalRoot === ctx.currentLexical
    || slot.canonicalRoot === ctx.currentCanonical
    || isSameOrChild(ctx.currentLexical, slot.lexicalRoot)
    || isSameOrChild(ctx.currentCanonical, slot.canonicalRoot);
}

/**
 * 字面或真实路径任一落进去的、**非当前槽**且不在白名单的家族槽（最长根优先）。
 * 不能让当前槽参与"谁最像"的挑选：字面路径停在当前槽、真实路径经软链落到别人槽时，
 * 按名字长度选会把别人的槽票投给当前槽，恰好放行最该拒的读取。
 */
function matchingForeignFamilySlot(
  candidateLexical: string,
  candidateCanonical: string,
  ctx: SlotGuardContext,
): FamilySlot | null {
  let best: FamilySlot | null = null;
  let bestLength = -1;
  for (const slot of ctx.familySlots) {
    if (isCurrentSlot(slot, ctx)) continue;
    if (crossSlotReadAllowed(slot.lexicalRoot, ctx.env) || crossSlotReadAllowed(slot.canonicalRoot, ctx.env)) {
      continue;
    }
    const hit = isSameOrChild(candidateLexical, slot.lexicalRoot)
      || isSameOrChild(candidateCanonical, slot.canonicalRoot);
    if (!hit) continue;
    if (slot.lexicalRoot.length >= bestLength) {
      best = slot;
      bestLength = slot.lexicalRoot.length;
    }
  }
  return best;
}

/** 按名字推断的槽也要过同一道"非当前、非白名单"筛；是当前槽就返回 null。 */
function foreignInferredFamilySlot(candidateLexical: string, ctx: SlotGuardContext): FamilySlot | null {
  const slot = inferredFamilySlot(candidateLexical, ctx.homeDirs);
  if (!slot || isCurrentSlot(slot, ctx)) return null;
  if (crossSlotReadAllowed(slot.lexicalRoot, ctx.env) || crossSlotReadAllowed(slot.canonicalRoot, ctx.env)) {
    return null;
  }
  return slot;
}

function denyReason(slotName: string): string {
  return `这是另一个槽（${slotName}）的数据目录，当前槽无权读取`;
}

function denyAccess(slot: FamilySlot, candidatePath: string): SlotDataDirAccess {
  return {
    allowed: false,
    reason: denyReason(slot.name),
    slotName: slot.name,
    slotRoot: slot.lexicalRoot,
    candidatePath,
  };
}

/**
 * 默认放行、命中即拒：任一路径（字面或真实）落进非当前、非白名单的家族槽就拒。
 * 没有"先验白名单短路"——当前槽的字面路径救不了真实路径指向别人的读取。
 */
function evaluateCandidate(candidatePath: string, ctx: SlotGuardContext): SlotDataDirAccess {
  const candidateLexical = lexicalPath(candidatePath);
  const candidateCanonical = canonicalize(candidatePath);

  const slot = matchingForeignFamilySlot(candidateLexical, candidateCanonical, ctx)
    ?? foreignInferredFamilySlot(candidateLexical, ctx);
  if (!slot) return { allowed: true };
  return denyAccess(slot, candidateLexical);
}

function toPosixRelative(from: string, to: string): string | null {
  const relative = path.relative(from, to);
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function evaluateSlotDataDirAccess(
  candidatePath: string,
  options: SlotDataDirGuardOptions = {},
): SlotDataDirAccess {
  return evaluateCandidate(candidatePath, buildGuardContext(options));
}

/**
 * 搜索根覆盖到的、非白名单的别人槽（当前槽不算）。
 * 工具侧遍历排除与 Bash 递归拒读共用这一份分类，防止两处口径漂移。
 */
function foreignSlotsUnderSearchRoot(
  searchLexical: string,
  searchCanonical: string,
  ctx: SlotGuardContext,
): FamilySlot[] {
  const result: FamilySlot[] = [];
  for (const slot of ctx.familySlots) {
    if (isCurrentSlot(slot, ctx)) continue;
    if (crossSlotReadAllowed(slot.lexicalRoot, ctx.env) || crossSlotReadAllowed(slot.canonicalRoot, ctx.env)) {
      continue;
    }
    const underSearch = isSameOrChild(slot.lexicalRoot, searchLexical)
      || isSameOrChild(slot.canonicalRoot, searchCanonical)
      || isSameOrChild(slot.canonicalRoot, searchLexical)
      || isSameOrChild(slot.lexicalRoot, searchCanonical);
    if (underSearch) result.push(slot);
  }
  return result;
}

/**
 * 递归搜索在遍历前要用的别人槽根。只返回落在 searchPath 下面的槽，
 * 当前槽和白名单槽不在内。ignore 是相对搜索根的字面路径，不逐文件 realpath。
 */
export function collectForeignSlotTraversalExcludes(
  searchPath: string,
  options: SlotDataDirGuardOptions = {},
): ForeignSlotTraversalExcludes {
  const ctx = buildGuardContext(options);
  const searchLexical = lexicalPath(searchPath);
  const searchCanonical = canonicalize(searchPath);
  const roots: string[] = [];
  const ignoreGlobs: string[] = [];
  const excludeDirNames: string[] = [];

  for (const slot of foreignSlotsUnderSearchRoot(searchLexical, searchCanonical, ctx)) {
    roots.push(slot.lexicalRoot, slot.canonicalRoot);
    const relative = toPosixRelative(searchLexical, slot.lexicalRoot)
      ?? toPosixRelative(searchCanonical, slot.canonicalRoot)
      ?? toPosixRelative(searchLexical, slot.canonicalRoot);
    if (relative) {
      ignoreGlobs.push(relative, `${relative}/**`);
      // --exclude-dir 按目录名匹配，会误伤同名目录：只有槽根是搜索根的直接子目录时
      // 排除才精确；槽根埋得更深时排除首段名等于删掉整棵子树（普通项目的匹配静默
      // 丢失），这种情况交给 roots 的结果侧前缀过滤兜底。
      const base = relative.split('/')[0];
      if (base && !relative.includes('/')) excludeDirNames.push(base);
    } else {
      excludeDirNames.push(slot.name);
    }
  }

  return {
    roots: uniqueStrings(roots),
    ignoreGlobs: uniqueStrings(ignoreGlobs),
    excludeDirNames: uniqueStrings(excludeDirNames),
  };
}

/** 结果侧前缀过滤：只 path.resolve，不 realpath。 */
export function isListedPathInsideForeignSlot(candidatePath: string, foreignRoots: string[]): boolean {
  if (foreignRoots.length === 0) return false;
  const resolved = lexicalPath(candidatePath);
  return foreignRoots.some((root) => isSameOrChild(resolved, root));
}

/**
 * Bash 里的递归遍历（grep -r 等）：起点覆盖别人的槽根就整条拒。
 * 工具侧（Grep/Glob）能边遍历边排除别人的槽根，Bash 命令是黑盒、改不了排除项，
 * 输出也无法可靠归因到路径，所以按起点 fail-closed。
 */
function evaluateBashTraversalRoot(rootPath: string, ctx: SlotGuardContext): SlotDataDirAccess {
  const rootLexical = lexicalPath(rootPath);
  const foreign = foreignSlotsUnderSearchRoot(rootLexical, canonicalize(rootPath), ctx);
  if (foreign.length === 0) return { allowed: true };
  const slot = foreign[0];
  return {
    allowed: false,
    reason: `递归搜索起点 ${rootLexical} 会遍历到${denyReason(slot.name)}；Bash 命令无法按槽根排除，请收窄搜索根或改用 Grep/Glob 工具`,
    slotName: slot.name,
    slotRoot: slot.lexicalRoot,
    candidatePath: rootLexical,
  };
}

export function evaluateToolSlotDataDirAccess(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
  options: SlotDataDirGuardOptions = {},
): SlotDataDirAccess {
  try {
    const ctx = buildGuardContext(options);
    const homeDir = options.homeDirs?.[0] ?? getHomeDir();
    const { candidates, traversalRoots } = collectToolPathCandidates(toolName, params, workingDirectory, homeDir);
    for (const candidate of candidates) {
      const verdict = evaluateCandidate(candidate, ctx);
      if (!verdict.allowed) return verdict;
    }

    for (const root of traversalRoots) {
      const verdict = evaluateBashTraversalRoot(root, ctx);
      if (!verdict.allowed) return verdict;
    }

    // 递归发现不能只判入口。入口是 home 时，真正读到的是下面的槽根。
    // 这里不整次拒掉（否则从 home glob 自己的槽也没了），槽根排除交给遍历/结果过滤。
    if (isRecursiveDiscoveryTool(toolName, params)) {
      const searchRoot = discoverySearchRoot(toolName, params, workingDirectory, homeDir);
      const searchVerdict = evaluateCandidate(searchRoot, ctx);
      if (!searchVerdict.allowed) return searchVerdict;
    }

    return { allowed: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      allowed: false,
      reason: `跨槽数据目录检查失败，已拒绝读取: ${detail}`,
      slotName: 'unknown',
      slotRoot: '',
      candidatePath: workingDirectory,
    };
  }
}
