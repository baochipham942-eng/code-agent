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
// 覆盖面 = 结构化参数工具（Read/Glob/Grep/LS 等）：路径由调用方明确给出，直接判定。
// Glob ** / Grep -r 会从允许的入口走进别人的槽根，槽根排除交给遍历/结果侧过滤
// （collectForeignSlotTraversalExcludes / isListedPathInsideForeignSlot）。
// 软链会让字面路径和真实路径分离：放行要求字面与真实路径都属于当前槽，
// 任一命中别人的槽就拒；realpath 仍要做（防 ~/x/../.code-agent）。
//
// Bash 不进这道守卫（ai-review 第 8 轮砍线）：从 shell 命令推断会读哪些路径，
// 枚举漏一个就等于放行，而 shell 语义的形状枚举不完（ADR-065：AST/推断可用于
// 「判定这条命令是什么」，不可用于「枚举需要检查什么」）。Bash 的跨槽读拦截
// 需要换机制（下沉 seatbelt 沙箱），不在本模块。
// ============================================================================

import { readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHomeDir, getUserConfigDir } from '../config/configPaths';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { CONFIG_DIR_NEW } from '../../shared/constants/configDir';

export const FOREIGN_SLOT_DATA_DIR_CODE = 'FOREIGN_SLOT_DATA_DIR';

/** 显式允许跨槽读取。仅评测/诊断用，取值 `'1'` 才放行。 */
const CROSS_SLOT_READ_ALLOW_ENV = 'CODE_AGENT_ALLOW_CROSS_SLOT_READ';

/** 逗号分隔的允许跨槽读取的数据目录绝对路径白名单。 */
const CROSS_SLOT_READ_ALLOWLIST_ENV = 'CODE_AGENT_CROSS_SLOT_READ_ALLOWLIST';

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

function isGrepTool(toolName: string): boolean {
  return toolName.trim().toLowerCase() === 'grep';
}

function isListDirectoryTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === 'listdirectory' || normalized === 'ls';
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

function collectToolPathCandidates(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
  homeDir: string = os.homedir(),
): string[] {
  const candidates: string[] = [lexicalPath(workingDirectory)];
  // 工具参数是 JSON 裸串：引号剥离在这一层做。
  const searchPath = typeof params.path === 'string' && params.path.trim()
    ? resolveCandidate(unquote(params.path), workingDirectory, homeDir)
    : lexicalPath(workingDirectory);

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!isPathLikeParamKey(key, toolName)) continue;
    const isGlobPattern = normalizeGlobTool(toolName) && key.toLowerCase() === 'pattern';
    // Glob pattern 的匹配基准是搜索根（params.path），不是会话 cwd。
    // `.code-agent/*.json` 相对 ~ 会变成生产槽路径，先被误拒，后面按 searchPath
    // 补的正确候选也救不回来（evaluateToolSlotDataDirAccess 遇第一个 deny 就返回）。
    if (!isGlobPattern) {
      candidates.push(resolveCandidate(unquote(value), workingDirectory, homeDir));
    } else {
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

  return uniqueLexical(candidates);
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

/**
 * 搜索根覆盖到的、非白名单的别人槽（当前槽不算）。
 * Glob/Grep 的遍历排除与结果过滤共用这一份分类。
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

  for (const slot of foreignSlotsUnderSearchRoot(searchLexical, searchCanonical, ctx)) {
    roots.push(slot.lexicalRoot, slot.canonicalRoot);
    const relative = toPosixRelative(searchLexical, slot.lexicalRoot)
      ?? toPosixRelative(searchCanonical, slot.canonicalRoot)
      ?? toPosixRelative(searchLexical, slot.canonicalRoot);
    if (relative) {
      ignoreGlobs.push(relative, `${relative}/**`);
    }
  }

  return {
    roots: uniqueStrings(roots),
    ignoreGlobs: uniqueStrings(ignoreGlobs),
  };
}

/** 结果侧前缀过滤：只 path.resolve，不 realpath。 */
export function isListedPathInsideForeignSlot(candidatePath: string, foreignRoots: string[]): boolean {
  if (foreignRoots.length === 0) return false;
  const resolved = lexicalPath(candidatePath);
  return foreignRoots.some((root) => isSameOrChild(resolved, root));
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
    const candidates = collectToolPathCandidates(toolName, params, workingDirectory, homeDir);
    for (const candidate of candidates) {
      const verdict = evaluateCandidate(candidate, ctx);
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
