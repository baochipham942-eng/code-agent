import * as path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import {
  createHostReason,
  HostReasonCode,
} from '../../shared/contract/permission';
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

/** Resolve filesystem components before comparing with the canonical workspace. */
function resolveCandidatePath(rawPath: string, context: WorkspaceWriteContext): string | null {
  // Absolute spellings may use a system alias (/var, /tmp) even when the run
  // anchor is already canonical. Resolve both sides instead of matching prefixes.
  const absolute = path.isAbsolute(rawPath);
  let cursor = absolute ? path.parse(rawPath).root : realpathSync.native(context.workingDirectory);
  const parts = rawPath.slice(absolute ? cursor.length : 0).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '.') continue;
    if (part === '..') return null;
    const next = path.join(cursor, part);
    try {
      const stat = lstatSync(next);
      if (index < parts.length - 1 && !stat.isDirectory() && !stat.isSymbolicLink()) return null;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      // Only the last component may be absent; its parent has already been checked.
      if (code !== 'ENOENT' || index !== parts.length - 1) return null;
      return next;
    }
    cursor = realpathSync.native(next);
  }
  return cursor;
}

/** A concession, not a shell interpreter: uncertainty always means no concession. */
function hasUnambiguousWorkspaceTargets(
  command: string,
  targets: string[],
  context: WorkspaceWriteContext,
): boolean {
  // Check the original text BEFORE decoded targets can hide quotes or token boundaries.
  // Conservatively require the producer and assignments to be literal ASCII too.
  if (!/^[\x20-\x7e]+$/.test(command) || /['"\\$`*?{}[\]()!^#~]/.test(command)) return false;
  if (command.split(' ').includes('--') || targets.length === 0 || !context.workspaceRoot) return false;
  try {
    const workspace = realpathSync.native(context.workspaceRoot);
    return targets.every((target) => {
      if (!/^[A-Za-z0-9_./:@%+,-]+$/.test(target) || target.startsWith('-')) return false;
      if (target.split('/').includes('..')) return false;
      const resolved = resolveCandidatePath(target, context);
      return resolved !== null && isPathInside(resolved, workspace);
    });
  } catch {
    return false;
  }
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
 * Relax approval only for unambiguous literal workspace writes.
 * All other supported writes retain confirmation, even if their decoded path
 * appears to be inside the workspace.
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
  if (!hasUnambiguousWorkspaceTargets(command, rawTargets, context)) {
    return outsideWorkspace('Workspace write requires confirmation', startTime);
  }

  return {
    decision: 'approve',
    reason: '写入项目目录内',
    confidence: 1,
    cached: false,
  };
}
