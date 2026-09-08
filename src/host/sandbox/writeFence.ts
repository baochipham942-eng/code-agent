import path from 'node:path';
import { parseShellCommand } from '../security/commandParse';
import { getSandboxManager } from './manager';

const FENCED_WRITE_PROGRAMS = new Set(['printf', 'echo', 'tee']);
/** Lookup / startup-file assignments that can change what the fenced command runs. Not an exhaustive bash env list. */
const LOOKUP_ASSIGNMENT = /^(PATH|CDPATH|ENV|BASH_ENV|SHELLOPTS|BASH_FUNC_[^=]*|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+)=/;
const SIMPLE_WRITE_PATH = /^[A-Za-z0-9._/+-]+$/;
/**
 * Eligibility-only screen so quoted redirects stay on the confirmation path
 * (`> "file"`, `> /proj/'o'`, `> "a"/"b"`). The OS fence is still the write gate.
 */
const QUOTED_REDIRECT_TARGET = /(?:[0-9]?>{1,2}|&>)\s*\S*['"`]/;

export const FENCED_IN_PROJECT_WRITE_REASON = 'in-project write under OS write fence';

let osWriteFenceAvailableOverride: boolean | undefined;

/**
 * Pin "fence present" or "fence absent" independently of the host OS.
 * Approval-eval uses this so ubuntu (no bwrap) still grades with-fence semantics.
 */
export function setOsWriteFenceAvailableOverride(value: boolean | undefined): void {
  osWriteFenceAvailableOverride = value;
}

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

/**
 * OS write fence is present (seatbelt/bwrap). Windows and missing jail are not.
 * Reverse mutation: dropping this check lets in-project-looking writes skip confirmation
 * without a real-path fence (N-WRITETARGET-EXECTIME).
 */
export function isOsWriteFenceAvailable(): boolean {
  if (osWriteFenceAvailableOverride !== undefined) return osWriteFenceAvailableOverride;
  if (process.platform === 'win32') return false;
  try {
    return getSandboxManager().isAvailable();
  } catch {
    return false;
  }
}

/**
 * Narrow eligibility for "just write a file in the project". Not a proof of the
 * real write path — the OS fence is. Quote/compound/lookup/printf -v stay out.
 */
export function isFencedInProjectWriteEligible(
  command: string,
  context: { workingDirectory: string; workspaceRoot?: string },
): boolean {
  const workspaceRoot = context.workspaceRoot;
  if (!workspaceRoot) return false;
  if (QUOTED_REDIRECT_TARGET.test(command)) return false;
  const parsed = parseShellCommand(command);
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
  const program = path.posix.basename(execution.program);
  if (!FENCED_WRITE_PROGRAMS.has(program)) return false;
  if (program === 'printf' && execution.args.some((arg) => arg === '-v' || arg.startsWith('-v'))) return false;
  if ((execution.environmentAssignments ?? []).some((assignment) => LOOKUP_ASSIGNMENT.test(assignment))) {
    return false;
  }
  return writeTargets.every((target) => (
    SIMPLE_WRITE_PATH.test(target.path.replaceAll('\\', '/'))
    && looksLexicallyInsideWorkspace(target.path, context.workingDirectory, workspaceRoot)
  ));
}
