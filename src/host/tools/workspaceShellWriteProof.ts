import * as os from 'node:os';
import * as path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import {
  createHostReason,
  HostReasonCode,
} from '../../shared/contract/permission';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { splitCompoundCommand } from '../security/commandSafety';
import { createTraceStep } from '../security/decisionTraceBuilder';
import type { ClassificationResult } from './permissionClassifier';
import { shellWriteTargets, staticShellCommandShape } from './writeTargets';

interface WorkspaceWriteContext {
  workingDirectory: string;
  workspaceRoot?: string;
  pathResolutionCache?: Map<string, string>;
}

const EXECUTION_SENSITIVE_ASSIGNMENT = /^(?:PATH|IFS|ENV|BASH_ENV|SHELLOPTS|LD_[A-Za-z0-9_]*|DYLD_[A-Za-z0-9_]*)=/;

function commandProgram(word: string | undefined): string {
  return word ?? '';
}

function hasUnsupportedShellControl(command: string): boolean {
  const segments = splitCompoundCommand(command);
  if (segments?.length !== 1) return true;

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
    if (char === '\n' || char === '\r' || char === '<') return true;
    if (char === '&' && command[index - 1] !== '>' && command[index + 1] !== '>') return true;
  }
  return quote !== undefined || escaped;
}

function resolveCandidatePath(rawPath: string, context: WorkspaceWriteContext): string | null {
  const cacheKey = `workspace-write\u0000${context.workingDirectory}\u0000${rawPath}`;
  const cached = context.pathResolutionCache?.get(cacheKey);
  if (cached) return cached;
  const expanded = rawPath === '~'
    ? os.homedir()
    : rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath;
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : `${resolveCanonicalRunPath(context.workingDirectory)}${path.sep}${expanded}`;
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '.') continue;
    if (part === '..') {
      cursor = path.dirname(cursor);
      continue;
    }

    const next = path.join(cursor, part);
    try {
      lstatSync(next);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : undefined;
      const hasUnresolvedSuffix = parts.slice(index + 1).some((suffix) => suffix !== '.');
      if (code !== 'ENOENT' || hasUnresolvedSuffix) return null;
      context.pathResolutionCache?.set(cacheKey, next);
      return next;
    }

    try {
      cursor = realpathSync.native(next);
    } catch {
      return null;
    }
  }

  context.pathResolutionCache?.set(cacheKey, cursor);
  return cursor;
}

function isPathInside(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function outsideWorkspace(reason: string, startTime: number, pathValue?: string): ClassificationResult {
  return {
    decision: 'ask',
    reason,
    ...(pathValue ? {
      hostReason: createHostReason(
        HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired,
        reason,
        { toolName: 'Bash', path: pathValue },
      ),
    } : {}),
    confidence: 1,
    cached: false,
    traceStep: createTraceStep('permission_classifier', 'W3: outside_project', 'ask', reason, startTime),
    trustBoundary: true,
  };
}

/**
 * Prove the two workspace-write families covered by the approval corpus.
 * The producer must remain known and every canonical target must stay in the
 * authoritative workspace; missing authority, dynamic targets, and external
 * paths all return an ask instead of an allow.
 */
export function classifyProvenWorkspaceWrite(
  command: string,
  context: WorkspaceWriteContext,
  startTime: number,
): ClassificationResult | null {
  if (hasUnsupportedShellControl(command)) return null;
  const shape = staticShellCommandShape(command);
  const words = shape?.words ?? [];
  const programIndex = shape?.leadingAssignmentCount ?? 0;
  const assignments = words.slice(0, programIndex);
  const program = commandProgram(words[programIndex]);
  const supportedShape = (program === 'printf' && assignments.length === 0)
    || (program === 'tee'
      && assignments.length > 0
      && assignments.every((assignment) => !EXECUTION_SENSITIVE_ASSIGNMENT.test(assignment)));
  if (!supportedShape) return null;

  const rawTargets = shellWriteTargets(command);
  if (rawTargets.length === 0) return null;
  const dynamicTarget = rawTargets.find((target) => (
    !target
    || /[$`*?{}[\]()!^#<>]/.test(target)
    || target.includes('~')
    || target.startsWith('=')
  ));
  if (dynamicTarget) return outsideWorkspace(`写入目标无法静态确认: ${dynamicTarget}`, startTime);
  if (!context.workspaceRoot) return outsideWorkspace('缺少工作区写入边界', startTime);

  const workspace = resolveCanonicalRunPath(context.workspaceRoot);
  const resolvedTargets: string[] = [];
  for (const target of rawTargets) {
    const resolved = resolveCandidatePath(target, context);
    if (!resolved) return outsideWorkspace(`写入目标无法按真实文件系统确认: ${target}`, startTime);
    resolvedTargets.push(resolved);
  }
  const externalTarget = resolvedTargets.find((target) => !isPathInside(target, workspace));
  if (externalTarget) return outsideWorkspace(`写入项目目录外: ${externalTarget}`, startTime, externalTarget);

  return {
    decision: 'approve',
    reason: '写入项目目录内',
    confidence: 1,
    cached: false,
  };
}
