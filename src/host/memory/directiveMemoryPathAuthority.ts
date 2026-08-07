import * as os from 'node:os';
import * as path from 'node:path';
import type {
  DirectiveMemoryWriteGrant,
  ToolDefinition,
  ToolPathAuthorityDescriptor,
} from '../../shared/contract';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import type { DirectiveMemoryConfirmationResult } from './directiveMemoryConfirmation';

export interface DirectiveMemoryWriteAssessment {
  requiresConfirmation: boolean;
  fingerprint: string;
  targets: readonly string[];
  preview: string;
}

interface AssessInput {
  definition: ToolDefinition;
  params: Record<string, unknown>;
  workingDirectory: string;
  agentRole?: string;
}

const PATH_LIKE_SUFFIXES = new Set(['file', 'path', 'directory', 'destination', 'target']);

function isPathLikeParameter(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return PATH_LIKE_SUFFIXES.has(normalized.split('_').at(-1) ?? '');
}

function resolveToolPath(rawPath: string, workingDirectory: string): string {
  const expanded = rawPath === '~'
    ? os.homedir()
    : rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath;
  return resolveCanonicalRunPath(
    path.isAbsolute(expanded) ? expanded : path.resolve(workingDirectory, expanded),
  );
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readShellWord(command: string, start: number): { raw: string; end: number } {
  let index = start;
  while (index < command.length && /\s/.test(command[index])) index += 1;
  const wordStart = index;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || char === ';' || char === '|' || char === '&') break;
  }
  return { raw: command.slice(wordStart, index), end: index };
}

function unquoteShellWord(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return raw.slice(1, -1);
    }
  }
  return raw.replace(/\\([\\'"\s])/g, '$1');
}

function shellRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== '>') continue;
    while (command[index + 1] === '>') index += 1;
    const target = readShellWord(command, index + 1);
    targets.push(target.raw);
    index = Math.max(index, target.end - 1);
  }
  return targets;
}

function pathAssessment(
  descriptor: Extract<ToolPathAuthorityDescriptor, { kind: 'path' }>,
  params: Record<string, unknown>,
  workingDirectory: string,
  memoryDir: string,
): string[] {
  const rawPath = params[descriptor.pathParameter];
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return [`uncertain:${descriptor.pathParameter}`];
  }
  const resolved = resolveToolPath(rawPath, workingDirectory);
  return isInside(resolved, memoryDir) ? [resolved] : [];
}

function shellAssessment(
  descriptor: Extract<ToolPathAuthorityDescriptor, { kind: 'shell' }>,
  params: Record<string, unknown>,
  workingDirectory: string,
  memoryDir: string,
): string[] {
  const command = params[descriptor.commandParameter];
  if (typeof command !== 'string' || command.trim() === '') {
    return [`uncertain:${descriptor.commandParameter}`];
  }

  const guarded: string[] = [];
  const memoryAlias = path.join(path.basename(path.dirname(memoryDir)), path.basename(memoryDir));
  if (command.includes(memoryDir) || command.includes(memoryAlias)) {
    guarded.push(memoryDir);
  }

  for (const rawTarget of shellRedirectTargets(command)) {
    const target = unquoteShellWord(rawTarget);
    if (!target || /[$`*?{}]/.test(target)) {
      guarded.push(`uncertain-redirection:${rawTarget || '<missing>'}`);
      continue;
    }
    const resolved = resolveToolPath(target, workingDirectory);
    if (isInside(resolved, memoryDir)) guarded.push(resolved);
  }
  return guarded;
}

function globalMemoryAssessment(
  descriptor: Extract<ToolPathAuthorityDescriptor, { kind: 'global-memory' }>,
  params: Record<string, unknown>,
  memoryDir: string,
  agentRole?: string,
): string[] {
  const scope = typeof params.scope === 'string' ? params.scope : undefined;
  if (scope === 'role' || scope === 'project' || (!scope && agentRole)) return [];
  const rawPath = params[descriptor.pathParameter];
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return [`uncertain:${descriptor.pathParameter}`];
  }
  return [resolveCanonicalRunPath(path.join(memoryDir, path.basename(rawPath)))];
}

function genericDeclaredPathAssessment(
  value: unknown,
  workingDirectory: string,
  memoryDir: string,
  key?: string,
): string[] {
  if (typeof value === 'string') {
    if (!key || !isPathLikeParameter(key)) return [];
    if (value.trim() === '') return [`uncertain:${key}`];
    const resolved = resolveToolPath(value, workingDirectory);
    return isInside(resolved, memoryDir) ? [resolved] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => genericDeclaredPathAssessment(
      entry,
      workingDirectory,
      memoryDir,
      key,
    ));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) => (
    genericDeclaredPathAssessment(childValue, workingDirectory, memoryDir, childKey)
  ));
}

export function assessDirectiveMemoryWrite(input: AssessInput): DirectiveMemoryWriteAssessment {
  const memoryDir = resolveCanonicalRunPath(getMemoryDir());
  // 通用扫描对**所有非 read 工具**生效。原先门在 permissionLevel === 'write' 上，
  // 而落盘能力根本不跟着这个档位走：screenshot_page / ppt_generate 是 'network' 档
  // 却带 output_path，git_worktree 是 'execute' 档却带 path——三个都能把文件落进记忆
  // 目录而一声不吭。bash 也正因为是 'execute' 档，通用扫描对它返回空，只能靠 #1005
  // 补的那行显式声明兜住。
  //
  // 翻成「非 read 一律扫」而不是继续按名字给工具补声明：新增工具默认被扫，漏的是
  // 「参数名不像路径」那一类（命令字符串、自造参数名），那类仍需显式 pathAuthority。
  // read 档不写盘，扫了只是白费 + 徒增误报。
  const genericTargets = input.definition.permissionLevel !== 'read'
    ? genericDeclaredPathAssessment(input.params, input.workingDirectory, memoryDir)
    : [];
  const targets = [
    ...genericTargets,
    ...(input.definition.pathAuthority ?? []).flatMap((descriptor) => {
      if (descriptor.kind === 'path') {
        return pathAssessment(descriptor, input.params, input.workingDirectory, memoryDir);
      }
      if (descriptor.kind === 'shell') {
        return shellAssessment(descriptor, input.params, input.workingDirectory, memoryDir);
      }
      return globalMemoryAssessment(descriptor, input.params, memoryDir, input.agentRole);
    }),
  ];
  const uniqueTargets = [...new Set(targets)].sort();
  const fingerprint = JSON.stringify({
    tool: input.definition.name,
    params: input.params,
    targets: uniqueTargets,
  });
  return {
    requiresConfirmation: uniqueTargets.length > 0,
    fingerprint,
    targets: uniqueTargets,
    preview: JSON.stringify(input.params).slice(0, 4_000),
  };
}

export function createDirectiveMemoryWriteGrant(
  assessment: DirectiveMemoryWriteAssessment,
  confirmation: DirectiveMemoryConfirmationResult,
): DirectiveMemoryWriteGrant {
  return {
    authority: 'directive-memory-write',
    fingerprint: assessment.fingerprint,
    requestId: confirmation.requestId,
    confirmedAt: confirmation.respondedAt,
  };
}

export function hasMatchingDirectiveMemoryWriteGrant(
  assessment: DirectiveMemoryWriteAssessment,
  grant: DirectiveMemoryWriteGrant | undefined,
): boolean {
  return !assessment.requiresConfirmation || (
    grant?.authority === 'directive-memory-write'
    && grant.fingerprint === assessment.fingerprint
  );
}
