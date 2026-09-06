// ============================================================================
// Slot data-dir isolation — default-deny reads of other CODE_AGENT_HOME slots
// ============================================================================
// 槽的存在意义就是隔离。folder-trust 管的是「工作目录可不可信」，不管
// 「另一个槽的私有数据目录能不能读」。这里拦的是后者。
//
// 判据不按名字枚举（.code-agent-dev / .code-agent-chatprobe …）：新开一个槽就漏一个。
// 家族 = home 下以 CONFIG_DIR_NEW 为前缀的直接子目录；不是当前 getUserConfigDir()
// 的，就是别人的。
// ============================================================================

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

function uniqueResolved(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const resolved = canonicalize(trimmed);
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

function resolveCandidate(raw: string, workingDirectory: string, homeDir: string): string {
  const expanded = expandHomePrefix(unquote(raw), homeDir);
  if (path.isAbsolute(expanded)) return canonicalize(expanded);
  return canonicalize(path.resolve(workingDirectory, expanded));
}

function extractEmbeddedFamilyMentions(text: string): string[] {
  const mentions: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(CONFIG_DIR_NEW, searchFrom);
    if (index < 0) break;
    searchFrom = index + CONFIG_DIR_NEW.length;
    let start = index;
    while (start > 0 && !/[\s'"`;|&<>]/.test(text[start - 1])) start -= 1;
    let end = index + CONFIG_DIR_NEW.length;
    while (end < text.length && !/[\s'"`;|&<>]/.test(text[end])) end += 1;
    const mention = text.slice(start, end);
    if (mention) mentions.push(mention);
  }
  return mentions;
}

function collectBashCandidates(command: string, workingDirectory: string, homeDir: string): string[] {
  const candidates: string[] = [];
  const words = commandWords(command) ?? [];
  for (const word of words) {
    const token = unquote(word);
    if (!looksLikePath(token)) continue;
    candidates.push(resolveCandidate(token, workingDirectory, homeDir));
  }
  for (const mention of extractEmbeddedFamilyMentions(command)) {
    candidates.push(resolveCandidate(mention, workingDirectory, homeDir));
  }
  return candidates;
}

function collectToolPathCandidates(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
  homeDir: string = os.homedir(),
): string[] {
  const candidates: string[] = [canonicalize(workingDirectory)];
  const searchPath = typeof params.path === 'string' && params.path.trim()
    ? resolveCandidate(params.path, workingDirectory, homeDir)
    : canonicalize(workingDirectory);

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
            : canonicalize(path.resolve(searchPath, expanded)),
        );
      }
    }
  }

  if (isBashTool(toolName) && typeof params.command === 'string') {
    const bashCwd = typeof params.working_directory === 'string' && params.working_directory.trim()
      ? resolveCandidate(params.working_directory, workingDirectory, homeDir)
      : canonicalize(workingDirectory);
    candidates.push(...collectBashCandidates(params.command, bashCwd, homeDir));
  }

  return uniqueResolved(candidates);
}

function crossSlotReadAllowed(slotRoot: string, env: NodeJS.ProcessEnv): boolean {
  if (env[CROSS_SLOT_READ_ALLOW_ENV]?.trim() === '1') return true;
  const raw = env[CROSS_SLOT_READ_ALLOWLIST_ENV]?.trim();
  if (!raw) return false;
  const allowed = raw.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean);
  const resolvedSlot = canonicalize(slotRoot);
  return allowed.some((entry) => canonicalize(entry) === resolvedSlot);
}

function familySlotRoot(candidate: string, homeDirs: string[]): string | null {
  for (const home of homeDirs) {
    if (!isSameOrChild(candidate, home)) continue;
    const relative = path.relative(home, candidate);
    const first = relative.split(path.sep).filter(Boolean)[0];
    if (!first?.startsWith(CONFIG_DIR_NEW)) continue;
    return path.join(home, first);
  }
  return null;
}

function denyReason(slotName: string): string {
  return `这是另一个槽（${slotName}）的数据目录，当前槽无权读取`;
}

export function evaluateSlotDataDirAccess(
  candidatePath: string,
  options: SlotDataDirGuardOptions = {},
): SlotDataDirAccess {
  const env = options.env ?? process.env;
  const currentDataDir = canonicalize(options.currentDataDir ?? getUserConfigDir());
  const homeDirs = uniqueResolved([
    ...(options.homeDirs ?? []),
    getHomeDir(),
    os.homedir(),
  ]);
  const candidate = canonicalize(candidatePath);

  if (isSameOrChild(candidate, currentDataDir)) {
    return { allowed: true };
  }

  const slotRoot = familySlotRoot(candidate, homeDirs);
  if (!slotRoot || slotRoot === currentDataDir) {
    return { allowed: true };
  }
  if (crossSlotReadAllowed(slotRoot, env)) {
    return { allowed: true };
  }

  const slotName = path.basename(slotRoot);
  return {
    allowed: false,
    reason: denyReason(slotName),
    slotName,
    slotRoot,
    candidatePath: candidate,
  };
}

export function evaluateToolSlotDataDirAccess(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
  options: SlotDataDirGuardOptions = {},
): SlotDataDirAccess {
  try {
    const homeDir = (options.homeDirs?.[0] ?? os.homedir());
    const candidates = collectToolPathCandidates(toolName, params, workingDirectory, homeDir);
    for (const candidate of candidates) {
      const verdict = evaluateSlotDataDirAccess(candidate, options);
      if (!verdict.allowed) return verdict;
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
