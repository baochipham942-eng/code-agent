import path from 'node:path';
import { homedir } from 'node:os';
import { getPolicyEngine } from '../../permissions/policyEngine';
import type { PolicyCheckResult, PolicyEnforcer } from '../../security/policyEnforcer';
import { createTraceStep } from '../../security/decisionTraceBuilder';

interface ConcreteWritePathDenyInput {
  /** Already resolved absolute path, same spelling checkFilePath sees for a shell target. */
  resolvedPath: string;
  workingDirectory: string;
  policyEnforcer: PolicyEnforcer | null | undefined;
  /** Extra spellings (raw command text, pre-canonical path) tried against Edit(path) denies. */
  pathCandidates?: readonly string[];
  /** Quoted in a user-rule deny reason. Defaults to the resolved path. */
  displayPath?: string;
}

/**
 * Hard deny for one concrete shell write path.
 * Filesystem policy (denied_paths, denied file patterns, writable_paths) and
 * user Edit/Write path denies both apply. An approval cannot override either.
 */
export function denyConcreteShellWritePath(
  input: ConcreteWritePathDenyInput,
): PolicyCheckResult | undefined {
  if (input.policyEnforcer?.isActive) {
    const policyCheck = input.policyEnforcer.checkFilePath(input.resolvedPath, 'write');
    if (!policyCheck.allowed) return policyCheck;
  }

  const relative = path.relative(input.workingDirectory, input.resolvedPath) || '.';
  const homeRelative = path.relative(homedir(), input.resolvedPath);
  const candidates = [...(input.pathCandidates ?? []), input.resolvedPath, relative];
  if (homeRelative && !homeRelative.startsWith('..') && !path.isAbsolute(homeRelative)) {
    candidates.push(`~/${homeRelative}`);
  }
  const matchedRule = getPolicyEngine().matchUserPathDeny(candidates);
  if (!matchedRule) return undefined;

  const displayPath = input.displayPath ?? input.resolvedPath;
  const reason = `Shell write target "${displayPath}" is denied by ${matchedRule.name}`;
  return {
    allowed: false,
    reason,
    section: 'user-permissions',
    traceStep: createTraceStep('policy_enforcer', matchedRule.id, 'deny', reason, Date.now()),
  };
}
