import path from 'node:path';
import { homedir } from 'node:os';
import { getPolicyEngine } from '../../permissions/policyEngine';
import type { PolicyCheckResult, PolicyEnforcer } from '../../security/policyEnforcer';
import { patternIntersectsSubpath } from '../../security/patternSubpath';
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

  const candidates = [
    ...(input.pathCandidates ?? []),
    ...pathSpellings(input.resolvedPath, input.workingDirectory),
  ];
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

function pathSpellings(resolvedPath: string, workingDirectory: string): string[] {
  const relative = path.relative(workingDirectory, resolvedPath) || '.';
  const homeRelative = path.relative(homedir(), resolvedPath);
  const candidates = [resolvedPath, relative];
  if (homeRelative && !homeRelative.startsWith('..') && !path.isAbsolute(homeRelative)) {
    candidates.push(`~/${homeRelative}`);
  }
  return candidates;
}

function userPathDenySpecifiers(): string[] {
  return getPolicyEngine().getRules().flatMap((rule) => {
    const specifier = rule.matcher.toolSpecifier;
    if (!rule.id.startsWith('user-deny-') || rule.action !== 'deny') return [];
    if (specifier?.specifierType !== 'path' || !specifier.specifier) return [];
    return [specifier.specifier];
  });
}

function absoluteUserPattern(specifier: string, workingDirectory: string): string {
  if (specifier === '~') return path.resolve(homedir());
  if (specifier.startsWith('~/')) return path.join(path.resolve(homedir()), specifier.slice(2));
  if (path.isAbsolute(specifier)) return specifier;
  if (specifier.startsWith('*') || specifier.startsWith('?')) return specifier;
  return path.resolve(workingDirectory, specifier);
}

/**
 * True when a seatbelt subpath grant on `resolvedPath` includes a write that
 * path policy still denies. The offered path itself is checked separately.
 */
export function deniedWriteInsideSeatbeltSubpath(input: {
  resolvedPath: string;
  workingDirectory: string;
  policyEnforcer: PolicyEnforcer | null | undefined;
  /** Denied operation was mkdir: a path that does not exist yet is a directory the retry would create. */
  missingPathIsDirectory?: boolean;
}): boolean {
  if (input.policyEnforcer?.isActive
    && input.policyEnforcer.writeSubpathIncludesFilesystemDeny(input.resolvedPath, input.missingPathIsDirectory === true)) {
    return true;
  }
  return userPathDenySpecifiers().some((specifier) => patternIntersectsSubpath(
    absoluteUserPattern(specifier, input.workingDirectory),
    input.resolvedPath,
    (candidate) => getPolicyEngine().matchUserPathDeny(
      pathSpellings(candidate, input.workingDirectory),
    ) !== null,
  ));
}
