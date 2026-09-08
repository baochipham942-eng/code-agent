import path from 'node:path';
import { parseShellCommand } from '../security/commandParse';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { getSandboxManager } from './manager';
import { isProtectedWritePath, isSensitiveCredentialPath } from './sensitivePaths';

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

let osWriteFenceAvailableOverride: boolean | undefined;

/** macOS /var ↔ /private/var aliases only. Does not follow user symlinks inside the project. */
function lexicalPathAliases(input: string): string[] {
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

function looksLexicallyInsideWorkspace(candidate: string, cwd: string, workspaceRoot: string): boolean {
  const targets = lexicalPathAliases(path.resolve(cwd, candidate));
  const roots = lexicalPathAliases(workspaceRoot);
  return targets.some((target) => roots.some((root) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }));
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
  const candidates = lexicalPathAliases(path.resolve(cwd, targetPath));
  const roots = lexicalPathAliases(workspaceRoot);
  return candidates.some((candidate) =>
    roots.some((root) => isSensitiveCredentialPath(candidate, { projectRoot: root })));
}

function isInProjectProtectedWrite(targetPath: string, cwd: string, workspaceRoot: string): boolean {
  const candidates = lexicalPathAliases(path.resolve(cwd, targetPath));
  const roots = lexicalPathAliases(workspaceRoot);
  return candidates.some((candidate) =>
    roots.some((root) => isProtectedWritePath(candidate, { projectRoot: root })));
}

/**
 * OS write fence is present (seatbelt/bwrap). Windows and missing jail are not.
 * Reverse mutation: dropping this check lets in-project-looking writes skip confirmation
 * without a real-path fence (N-WRITETARGET-EXECTIME).
 */
export const isOsWriteFenceAvailable = Object.assign(
  function isOsWriteFenceAvailable(): boolean {
    if (osWriteFenceAvailableOverride !== undefined) return osWriteFenceAvailableOverride;
    if (process.platform === 'win32') return false;
    try {
      return getSandboxManager().isAvailable();
    } catch {
      return false;
    }
  },
  {
    /** Test-only / eval-fixture pin for "fence present" or "fence absent". */
    setAvailableOverrideForTest(value: boolean | undefined): void {
      osWriteFenceAvailableOverride = value;
    },
  },
);

/**
 * Narrow eligibility for "just write a file in the project". Not a proof of the
 * real write path — the OS fence is. Quote/compound/lookup/printf -v stay out.
 */
export function isFencedInProjectWriteEligible(
  command: string,
  context: { workingDirectory: string; workspaceRoot?: string },
): boolean {
  if (!context.workspaceRoot) return false;
  const workspaceRoot = tryCanonicalFencePath(context.workspaceRoot);
  const workingDirectory = tryCanonicalFencePath(context.workingDirectory);
  if (!workspaceRoot || !workingDirectory) return false;
  if (QUOTED_REDIRECT_TARGET.test(command)) return false;
  const parsed = parseShellCommand(command);
  if (commandHasExpansionMarker(command, parsed)) return false;
  if (parsed.parsingFailed || parsed.trailingOperator || parsed.uncertain.length > 0) return false;
  if (parsed.segments.length !== 1) return false;
  const segment = parsed.segments[0];
  if (segment.terminator === '&' || segment.reads.length > 0) return false;
  const writeTargets = parsed.writeTargets.filter((target) => target.path !== '/dev/null');
  if (writeTargets.length === 0 || writeTargets.some((target) => target.uncertain)) return false;
  if (parsed.executions.length !== 1) return false;
  const execution = parsed.executions[0];
  if (execution.wrappers.length > 0) return false;
  if (execution.program.includes('/') || execution.program.includes('\\')) return false;
  if (!FENCED_WRITE_PROGRAMS.has(execution.program)) return false;
  if (execution.program === 'printf' && execution.args.some((arg) => arg === '-v' || arg.startsWith('-v'))) {
    return false;
  }
  if ((execution.environmentAssignments ?? []).some((assignment) => LOOKUP_ASSIGNMENT.test(assignment))) {
    return false;
  }
  return writeTargets.every((target) => {
    if (!SIMPLE_WRITE_PATH.test(target.path.replaceAll('\\', '/'))) return false;
    if (!looksLexicallyInsideWorkspace(target.path, workingDirectory, workspaceRoot)) return false;
    // OS fence does not protect in-project .env* or constraint files.
    // Reverse mutation: drop credential check ⇒ printf x > .env auto-approves.
    // Reverse mutation: drop case fold in isSensitiveCredentialPath ⇒ printf x >> .ENV auto-approves.
    if (isInProjectCredentialWrite(target.path, workingDirectory, workspaceRoot)) return false;
    // Same shape as .env: protected writes lose auto-approve even when the OS jail is up.
    if (isInProjectProtectedWrite(target.path, workingDirectory, workspaceRoot)) return false;
    return true;
  });
}
