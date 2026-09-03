import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { canonicalizeCommand } from './canonicalizeCommand';

export interface RecursiveRmPathContext {
  workingDirectory: string;
  workspaceRoot?: string;
}

const HOME_DIR = resolveCanonicalRunPath(os.homedir());
const SYSTEM_DIRECTORIES = [
  'System', 'usr', 'bin', 'sbin', 'etc', 'var', 'private', 'opt', 'cores', 'dev', 'Network', 'Library',
].map((name) => resolveCanonicalRunPath(path.join(path.parse(HOME_DIR).root, name)));

function commandProgram(word: string | undefined): string {
  return word ? path.posix.basename(word) : '';
}

function expandLeadingHome(rawPath: string): string {
  if (rawPath === '~') return HOME_DIR;
  if (rawPath.startsWith('~/')) return path.join(HOME_DIR, rawPath.slice(2));
  if (rawPath === '$HOME' || rawPath === '${HOME}') return HOME_DIR;
  if (rawPath.startsWith('$HOME/')) return path.join(HOME_DIR, rawPath.slice(6));
  if (rawPath.startsWith('${HOME}/')) return path.join(HOME_DIR, rawPath.slice(8));
  return rawPath;
}

function isPathInside(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string): string {
  return resolveCanonicalRunPath(path.resolve(candidate));
}

function resolvedRmTargets(command: string, workingDirectory: string): {
  recursive: boolean;
  targets: string[];
} | null {
  const words = canonicalizeCommand(command).command.split(/\s+/).filter(Boolean);
  const rmIndex = words.findIndex((word) => commandProgram(word) === 'rm');
  if (rmIndex < 0) return null;

  const args = words.slice(rmIndex + 1);
  const recursive = args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg));
  const cwd = canonicalPath(workingDirectory);
  const targets = args
    .filter((arg) => arg !== '--' && !arg.startsWith('-'))
    .map((target) => {
      const expanded = expandLeadingHome(target);
      const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
      return canonicalPath(absolute);
    });
  return { recursive, targets };
}

function resolvedRecursiveRmTargets(command: string, workingDirectory: string): string[] | null {
  const analysis = resolvedRmTargets(command, workingDirectory);
  return analysis?.recursive ? analysis.targets : null;
}

export function resolvedRmCriticalTarget(
  command: string,
  context: RecursiveRmPathContext,
): string | null {
  const workdir = canonicalPath(context.workingDirectory);
  const workspace = canonicalPath(context.workspaceRoot ?? workdir);
  const targets = resolvedRecursiveRmTargets(command, workdir);
  if (!targets) return null;

  for (const resolved of targets) {
    const root = path.parse(resolved).root;
    const rootLevel = path.dirname(resolved) === root;
    const workdirOrParent = isPathInside(workdir, resolved);
    if (resolved === root || rootLevel || resolved === HOME_DIR || workdirOrParent) return resolved;

    // A workspace may legitimately live below a lexical system directory such
    // as macOS /var/folders (whose real path is /private/var/folders).
    if (isPathInside(resolved, workspace)) continue;

    if (SYSTEM_DIRECTORIES.some((directory) => isPathInside(resolved, directory))) return resolved;
  }
  return null;
}

export function rmIsContainedInWorkspace(
  command: string,
  context: RecursiveRmPathContext,
): boolean {
  const workdir = canonicalPath(context.workingDirectory);
  const workspace = canonicalPath(context.workspaceRoot ?? workdir);
  const analysis = resolvedRmTargets(command, workdir);
  if (!analysis?.targets.length) return false;
  return analysis.targets.every((resolved) => (
    isPathInside(resolved, workspace)
    && !isPathInside(workdir, resolved)
  ));
}
