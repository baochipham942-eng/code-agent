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
// - Bash 的 cd 会改后续命令的 cwd
// - Glob ** / Grep -r 会从允许的入口走进别人的槽根
// - 软链会让字面路径和真实路径分离
// 字面路径与真实路径任一命中别人的槽就拒；realpath 仍要做（防 ~/x/../.code-agent）。
// ============================================================================

import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHomeDir, getUserConfigDir } from '../config/configPaths';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { commandWords } from './commandSafety';
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
  const resolved = path.resolve(input);
  try {
    return resolveCanonicalRunPath(resolved);
  } catch {
    return resolved;
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

function resolveCandidate(raw: string, workingDirectory: string, homeDir: string): string {
  const expanded = expandHomePrefix(unquote(raw), homeDir);
  if (path.isAbsolute(expanded)) return lexicalPath(expanded);
  return lexicalPath(path.resolve(workingDirectory, expanded));
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
  if (words[0] === 'builtin' || words[0] === 'command') return 1;
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

/**
 * Quote-aware split on && || ; | newline and grouping parens/braces.
 * Unlike commandSafety.splitCompoundCommand, subshells stay analyzable so
 * `(cd X; cat …)` can still advance cwd inside the group.
 */
function splitShellSegments(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let index = 0;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = '';
  };

  while (index < command.length) {
    const char = command[index];
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      index += 1;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      index += 1;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '&' && command[index + 1] === '&') {
        push();
        index += 2;
        continue;
      }
      if (char === '|' && command[index + 1] === '|') {
        push();
        index += 2;
        continue;
      }
      if (char === ';' || char === '|' || char === '\n' || char === '(' || char === ')' || char === '{' || char === '}') {
        push();
        index += 1;
        continue;
      }
    }
    current += char;
    index += 1;
  }
  push();
  return parts;
}

function commandLooksUnanalyzable(command: string): boolean {
  return /\$\(/.test(command) || /`[^`]+`/.test(command);
}

function collectPathTokens(command: string, cwd: string, homeDir: string): string[] {
  const candidates: string[] = [];
  const words = commandWords(command) ?? [];
  for (const word of words) {
    const token = unquote(word);
    if (!looksLikePath(token)) continue;
    candidates.push(resolveCandidate(token, cwd, homeDir));
  }
  for (const mention of extractEmbeddedFamilyMentions(command)) {
    candidates.push(resolveCandidate(mention, cwd, homeDir));
  }
  return candidates;
}

function collectBashCandidates(command: string, workingDirectory: string, homeDir: string): string[] {
  const candidates: string[] = [];
  const segments = splitShellSegments(command);
  const unanalyzable = commandLooksUnanalyzable(command);
  let cwd = workingDirectory;
  let cwdKnown = !unanalyzable;
  const cwdBases = new Set<string>([workingDirectory]);

  for (const segment of segments) {
    const words = commandWords(segment);
    if (words && isCwdCommand(words)) {
      const nextCwd = resolveCdTarget(words, cwd, homeDir);
      if (nextCwd) {
        candidates.push(nextCwd);
        cwd = nextCwd;
        cwdBases.add(nextCwd);
        continue;
      }
      cwdKnown = false;
      cwdBases.add(homeDir);
      continue;
    }
    if (cwdKnown) {
      candidates.push(...collectPathTokens(segment, cwd, homeDir));
      continue;
    }
    for (const base of cwdBases) {
      candidates.push(...collectPathTokens(segment, base, homeDir));
    }
    candidates.push(...collectPathTokens(segment, homeDir, homeDir));
  }

  if (!cwdKnown || unanalyzable) {
    for (const base of cwdBases) {
      candidates.push(...collectPathTokens(command, base, homeDir));
    }
    candidates.push(...collectPathTokens(command, homeDir, homeDir));
  }

  return candidates;
}

function collectToolPathCandidates(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
  homeDir: string = os.homedir(),
): string[] {
  const candidates: string[] = [lexicalPath(workingDirectory)];
  const searchPath = typeof params.path === 'string' && params.path.trim()
    ? resolveCandidate(params.path, workingDirectory, homeDir)
    : lexicalPath(workingDirectory);

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!isPathLikeParamKey(key, toolName)) continue;
    candidates.push(resolveCandidate(value, workingDirectory, homeDir));
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
      ? resolveCandidate(params.working_directory, workingDirectory, homeDir)
      : lexicalPath(workingDirectory);
    candidates.push(...collectBashCandidates(params.command, bashCwd, homeDir));
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
    return resolveCandidate(params.path, workingDirectory, homeDir);
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

function isOwnDataDir(candidateLexical: string, candidateCanonical: string, ctx: SlotGuardContext): boolean {
  return isSameOrChild(candidateLexical, ctx.currentLexical)
    || isSameOrChild(candidateCanonical, ctx.currentCanonical);
}

function matchingFamilySlot(
  candidateLexical: string,
  candidateCanonical: string,
  ctx: SlotGuardContext,
): FamilySlot | null {
  let best: FamilySlot | null = null;
  let bestLength = -1;
  for (const slot of ctx.familySlots) {
    const hit = isSameOrChild(candidateLexical, slot.lexicalRoot)
      || isSameOrChild(candidateCanonical, slot.canonicalRoot);
    if (!hit) continue;
    if (slot.lexicalRoot.length >= bestLength) {
      best = slot;
      bestLength = slot.lexicalRoot.length;
    }
  }
  if (best) return best;
  return inferredFamilySlot(candidateLexical, ctx.homeDirs);
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

function evaluateCandidate(candidatePath: string, ctx: SlotGuardContext): SlotDataDirAccess {
  const candidateLexical = lexicalPath(candidatePath);
  const candidateCanonical = canonicalize(candidatePath);

  if (isOwnDataDir(candidateLexical, candidateCanonical, ctx)) {
    return { allowed: true };
  }

  const slot = matchingFamilySlot(candidateLexical, candidateCanonical, ctx);
  if (!slot || isCurrentSlot(slot, ctx)) {
    return { allowed: true };
  }
  if (crossSlotReadAllowed(slot.lexicalRoot, ctx.env) || crossSlotReadAllowed(slot.canonicalRoot, ctx.env)) {
    return { allowed: true };
  }
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

  for (const slot of ctx.familySlots) {
    if (isCurrentSlot(slot, ctx)) continue;
    if (crossSlotReadAllowed(slot.lexicalRoot, ctx.env) || crossSlotReadAllowed(slot.canonicalRoot, ctx.env)) {
      continue;
    }
    const underSearch = isSameOrChild(slot.lexicalRoot, searchLexical)
      || isSameOrChild(slot.canonicalRoot, searchCanonical)
      || isSameOrChild(slot.canonicalRoot, searchLexical)
      || isSameOrChild(slot.lexicalRoot, searchCanonical);
    if (!underSearch) continue;

    roots.push(slot.lexicalRoot, slot.canonicalRoot);
    const relative = toPosixRelative(searchLexical, slot.lexicalRoot)
      ?? toPosixRelative(searchCanonical, slot.canonicalRoot)
      ?? toPosixRelative(searchLexical, slot.canonicalRoot);
    if (relative) {
      ignoreGlobs.push(relative, `${relative}/**`);
      const base = relative.split('/')[0];
      if (base) excludeDirNames.push(base);
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
