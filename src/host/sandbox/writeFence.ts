import path from 'node:path';
import { parseShellCommand } from '../security/commandParse';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { CONFIG_DIR_LEGACY, CONFIG_DIR_NEW } from '../../shared/constants/configDir';
import { getSandboxManager } from './manager';
import { isProtectedWritePath, isSensitiveCredentialPath, pathAliases } from './sensitivePaths';

const FENCED_WRITE_PROGRAMS = new Set(['printf', 'echo', 'tee']);
/** Lookup / startup-file assignments that can change what the fenced command runs. Not an exhaustive bash env list. */
const LOOKUP_ASSIGNMENT = /^(PATH|CDPATH|ENV|BASH_ENV|SHELLOPTS|BASH_FUNC_[^=]*|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+)=/;
const SIMPLE_WRITE_PATH = /^[A-Za-z0-9._/+-]+$/;
/**
 * Eligibility-only screen so quoted redirects stay on the confirmation path
 * (`> "file"`, `> /proj/'o'`, `> "a"/"b"`). Quoted tee operands are not matched
 * here: they go through parseShellCommand + SIMPLE_WRITE_PATH after quotes are
 * stripped (`tee "out.txt"` can still be eligible). The OS fence is still the write gate.
 */
const QUOTED_REDIRECT_TARGET = /(?:[0-9]?>{1,2}|&>)\s*\S*['"`]/;
/**
 * Fail-closed expansion / substitution in any word, including after quote stripping.
 * `$(` `${` backticks process-substitution, and a bare `$` (so `echo "100$"` asks).
 * Reverse mutation: drop commandHasExpansionMarker ⇒ `printf "${VAR}" > out.txt`
 * and `echo "100$"` become eligible.
 */
const EXPANSION_MARKER = /\$|`|<\(|>\(/;

export const FENCED_IN_PROJECT_WRITE_REASON = 'in-project write under OS write fence';

function writeTargetAliases(targetPath: string, cwd: string): string[] {
  const resolved = path.resolve(cwd, targetPath);
  // Same existing-prefix walk as cwd/workspace (pathAliases one-parent is not enough
  // for /tmp/proj when only /tmp exists). Reverse mutation: drop this ⇒ /tmp vs
  // /private/tmp ordinary writes stop matching, and `deploy -> .git/hooks` stays lexical.
  const canonical = tryCanonicalFencePath(resolved) ?? resolved;
  return pathAliases(canonical);
}

function isInsideWorkspaceRoot(candidate: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function looksInsideWorkspace(targetPath: string, cwd: string, workspaceRoot: string): boolean {
  const targets = writeTargetAliases(targetPath, cwd);
  const roots = pathAliases(workspaceRoot);
  return targets.some((target) => roots.some((root) => isInsideWorkspaceRoot(target, root)));
}

/** macOS /var ↔ /private/var aliases only. Does not follow user symlinks inside the project. */
function lexicalOsPathAliases(input: string): string[] {
  const resolved = path.resolve(input);
  const aliases = [resolved];
  if (resolved === '/var' || resolved.startsWith('/var/')) aliases.push(`/private${resolved}`);
  else if (resolved === '/private/var' || resolved.startsWith('/private/var/')) {
    aliases.push(resolved.slice('/private'.length));
  }
  if (resolved === '/tmp' || resolved.startsWith('/tmp/')) aliases.push(`/private${resolved}`);
  else if (resolved === '/private/tmp' || resolved.startsWith('/private/tmp/')) {
    aliases.push(resolved.slice('/private'.length));
  }
  return [...new Set(aliases)];
}

function looksLexicallyInsideWorkspace(targetPath: string, cwd: string, workspaceRoot: string): boolean {
  const targets = lexicalOsPathAliases(path.resolve(cwd, targetPath));
  const roots = lexicalOsPathAliases(workspaceRoot);
  return targets.some((target) => roots.some((root) => isInsideWorkspaceRoot(target, root)));
}

function tryCanonicalFencePath(input: string): string | undefined {
  try {
    return resolveCanonicalRunPath(input);
  } catch {
    return undefined;
  }
}

function hasExpansionMarker(text: string): boolean {
  return EXPANSION_MARKER.test(text);
}

function commandHasExpansionMarker(command: string, parsed: ReturnType<typeof parseShellCommand>): boolean {
  if (hasExpansionMarker(command)) return true;
  if (parsed.uncertain.length > 0) return true;
  if (parsed.segments.some((segment) =>
    segment.words.some(hasExpansionMarker)
    || segment.redirects.some((target) => target.uncertain || hasExpansionMarker(target.path))
    || segment.reads.some((read) => read.uncertain || hasExpansionMarker(read.path))
  )) return true;
  if (parsed.executions.some((execution) =>
    hasExpansionMarker(execution.program)
    || execution.args.some(hasExpansionMarker)
    || (execution.environmentAssignments ?? []).some(hasExpansionMarker)
  )) return true;
  return parsed.writeTargets.some((target) => target.uncertain || hasExpansionMarker(target.path));
}

function isInProjectCredentialWrite(targetPath: string, cwd: string, workspaceRoot: string): boolean {
  const candidates = writeTargetAliases(targetPath, cwd);
  const roots = pathAliases(workspaceRoot);
  return candidates.some((candidate) =>
    roots.some((root) => isSensitiveCredentialPath(candidate, { projectRoot: root })));
}

function isInProjectProtectedWrite(targetPath: string, cwd: string, workspaceRoot: string): boolean {
  const candidates = writeTargetAliases(targetPath, cwd);
  const roots = pathAliases(workspaceRoot);
  return candidates.some((candidate) =>
    roots.some((root) => isProtectedWritePath(candidate, { projectRoot: root })));
}

/** Directories git / husky / Neo later execute from. Folded; prefix match includes children. */
const PROJECT_STARTUP_EXECUTABLE_PREFIXES = [
  '.git/hooks',
  '.husky',
  `${CONFIG_DIR_NEW}/hooks`,
  `${CONFIG_DIR_NEW}/agents`,
  `${CONFIG_DIR_NEW}/skills`,
  `${CONFIG_DIR_LEGACY}/skills`,
].map((relative) => relative.toLowerCase());

/** Project files Neo later reads as config or uses to spawn / schedule. Folded exact match. */
const PROJECT_RUNTIME_CONFIG_FILES = new Set([
  `${CONFIG_DIR_NEW}/settings.json`,
  `${CONFIG_DIR_NEW}/mcp.json`,
  `${CONFIG_DIR_NEW}/mcp.local.json`,
  `${CONFIG_DIR_NEW}/heartbeat.md`,
  `${CONFIG_DIR_LEGACY}/settings.json`,
].map((relative) => relative.toLowerCase()));

function foldedProjectRelative(candidate: string, projectRoot: string): string | undefined {
  const relative = path.relative(projectRoot, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.replaceAll('\\', '/').toLowerCase();
}

function isStartupExecutableRelative(candidate: string, projectRoot: string): boolean {
  const folded = foldedProjectRelative(candidate, projectRoot);
  if (!folded) return false;
  if (PROJECT_RUNTIME_CONFIG_FILES.has(folded)) return true;
  return PROJECT_STARTUP_EXECUTABLE_PREFIXES.some((prefix) => (
    folded === prefix || folded.startsWith(`${prefix}/`)
  ));
}

function isInProjectStartupExecutableWrite(targetPath: string, cwd: string, workspaceRoot: string): boolean {
  const candidates = writeTargetAliases(targetPath, cwd);
  const roots = pathAliases(workspaceRoot);
  return candidates.some((candidate) =>
    roots.some((root) => isStartupExecutableRelative(candidate, root)));
}

/**
 * OS write fence is present (seatbelt/bwrap). Windows and missing jail are not.
 * Reverse mutation: dropping this check lets in-project-looking writes skip confirmation
 * without a real-path fence (N-WRITETARGET-EXECTIME).
 */
export function isOsWriteFenceAvailable(): boolean {
  try {
    const manager = getSandboxManager();
    // wrapCommand throws when disabled; treat disabled as "no fence" so skip-confirm
    // falls back to ask instead of a hard SANDBOX_UNAVAILABLE error.
    return manager.isAvailable() && manager.isEnabled();
  } catch {
    return false;
  }
}

function inspectFencedWrite(
  command: string,
  context: { workingDirectory: string; workspaceRoot?: string },
): { workingDirectory: string; workspaceRoot: string; writeTargets: Array<{ path: string }> } | undefined {
  if (!context.workspaceRoot) return undefined;
  const workspaceRoot = tryCanonicalFencePath(context.workspaceRoot);
  const workingDirectory = tryCanonicalFencePath(context.workingDirectory);
  if (!workspaceRoot || !workingDirectory) return undefined;
  if (QUOTED_REDIRECT_TARGET.test(command)) return undefined;
  const parsed = parseShellCommand(command);
  if (commandHasExpansionMarker(command, parsed)) return undefined;
  if (parsed.parsingFailed || parsed.trailingOperator || parsed.uncertain.length > 0) return undefined;
  if (parsed.segments.length !== 1) return undefined;
  const segment = parsed.segments[0];
  if (segment.terminator === '&' || segment.reads.length > 0) return undefined;
  const writeTargets = parsed.writeTargets.filter((target) => target.path !== '/dev/null');
  if (writeTargets.length === 0 || writeTargets.some((target) => target.uncertain)) return undefined;
  if (parsed.executions.length !== 1) return undefined;
  const execution = parsed.executions[0];
  if (execution.wrappers.length > 0) return undefined;
  if (execution.program.includes('/') || execution.program.includes('\\')) return undefined;
  if (!FENCED_WRITE_PROGRAMS.has(execution.program)) return undefined;
  if (execution.program === 'printf' && execution.args.some((arg) => arg === '-v' || arg.startsWith('-v'))) {
    return undefined;
  }
  if ((execution.environmentAssignments ?? []).some((assignment) => LOOKUP_ASSIGNMENT.test(assignment))) {
    return undefined;
  }
  if (writeTargets.some((target) => !SIMPLE_WRITE_PATH.test(target.path.replaceAll('\\', '/')))) return undefined;
  return { workingDirectory, workspaceRoot, writeTargets };
}

/**
 * Wrap simple in-project-looking writes in the OS jail. Lexical inside only —
 * user symlinks that escape the project stay fenced so seatbelt/bwrap is the gate.
 */
export function isFencedWriteSandboxEligible(
  command: string,
  context: { workingDirectory: string; workspaceRoot?: string },
): boolean {
  const inspected = inspectFencedWrite(command, context);
  if (!inspected) return false;
  return inspected.writeTargets.every((target) => (
    looksLexicallyInsideWorkspace(target.path, inspected.workingDirectory, inspected.workspaceRoot)
  ));
}

/**
 * Narrow skip-confirm eligibility. Quote/compound/lookup/printf -v stay out.
 * Canonical inside + credential/startup-config exclusions; the OS fence is still
 * the write gate for lexical-in-project paths that resolve outside.
 */
export function isFencedInProjectWriteEligible(
  command: string,
  context: { workingDirectory: string; workspaceRoot?: string },
): boolean {
  const inspected = inspectFencedWrite(command, context);
  if (!inspected) return false;
  const { workingDirectory, workspaceRoot, writeTargets } = inspected;
  return writeTargets.every((target) => {
    if (!looksInsideWorkspace(target.path, workingDirectory, workspaceRoot)) return false;
    // OS fence does not protect in-project .env* or constraint files.
    // Reverse mutation: drop credential check ⇒ printf x > .env auto-approves.
    // Reverse mutation: drop case fold in isSensitiveCredentialPath ⇒ printf x >> .ENV auto-approves.
    if (isInProjectCredentialWrite(target.path, workingDirectory, workspaceRoot)) return false;
    // Same shape as .env: protected writes lose auto-approve even when the OS jail is up.
    if (isInProjectProtectedWrite(target.path, workingDirectory, workspaceRoot)) return false;
    // Reverse mutation: drop startup-executable prefixes ⇒ .git/hooks / hooks.json /
    // mcp.json skip confirmation while remaining in-project.
    if (isInProjectStartupExecutableWrite(target.path, workingDirectory, workspaceRoot)) return false;
    return true;
  });
}
