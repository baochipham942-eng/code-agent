/**
 * Pure file-level shell/path helpers split out of permissionClassifier.ts (max-lines).
 * Moved verbatim; permissionClassifier.ts re-exports bashCommandRequiresPermission.
 */
import * as os from 'os';
import * as path from 'path';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import {
  commandWords as tokenizeCommandWords, splitCompoundCommand,
} from '../security/commandSafety';
import {
  lenientCommandWords, listTerminatorAfter, parseShellCommand, type SegmentTerminator,
} from '../security/commandParse';
import { isSensitiveCredentialPath } from '../sandbox/sensitivePaths';
import { anchoredAllowCommandWords } from '../security/commandAllowProof';
import { resolvedRmCriticalTarget } from '../security/recursiveRmPathSafety';
import { normalizeToolName } from './toolNames';
import type { ClassificationContext } from './permissionClassifier';

const HOME_DIR = os.homedir();
export const CANONICAL_HOME_DIR = resolveCanonicalRunPath(HOME_DIR);
const CLAUDE_MEMORY_DIR = path.join(CANONICAL_HOME_DIR, '.claude', 'context', 'memory');
const CLAUDE_PROJECTS_DIR = path.join(CANONICAL_HOME_DIR, '.claude', 'projects');
const CODEX_MEMORIES_DIR = path.join(CANONICAL_HOME_DIR, '.codex', 'memories');

function expandLeadingTilde(rawPath: string): string {
  if (rawPath === '~') return HOME_DIR;
  if (rawPath.startsWith('~/')) return path.join(HOME_DIR, rawPath.slice(2));
  if (rawPath === '$HOME' || rawPath === '${HOME}') return HOME_DIR;
  if (rawPath.startsWith('$HOME/')) return path.join(HOME_DIR, rawPath.slice(6));
  if (rawPath.startsWith('${HOME}/')) return path.join(HOME_DIR, rawPath.slice(8));
  return rawPath;
}

function stripInlineReadParams(rawPath: string): string {
  const trimmed = rawPath.trim();

  const linesMatch = trimmed.match(/^(.+?)\s+lines?\s+\d+(?:-\d+)?$/i);
  if (linesMatch) {
    return linesMatch[1].trim();
  }

  const offsetLimitMatch = trimmed.match(/^(.+?)\s+(?:offset|limit)\b.*$/i);
  if (offsetLimitMatch) {
    return offsetLimitMatch[1].trim();
  }

  return trimmed;
}

export function resolveCandidatePath(rawPath: string, workingDirectory: string, cache?: Map<string, string>): string {
  if (rawPath.includes('\0')) throw new Error('NUL byte cannot be resolved as a filesystem path');
  const cacheKey = `${workingDirectory}\u0000${rawPath}`;
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const sanitized = stripInlineReadParams(rawPath);
  const expanded = expandLeadingTilde(sanitized);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workingDirectory, expanded);
  const canonical = resolveCanonicalRunPath(resolved);
  cache?.set(cacheKey, canonical);
  return canonical;
}

export function isPathInside(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isSensitiveMemoryPath(resolvedPath: string): boolean {
  if (resolvedPath === CLAUDE_MEMORY_DIR || resolvedPath.startsWith(`${CLAUDE_MEMORY_DIR}${path.sep}`)) {
    return true;
  }

  if (resolvedPath === CODEX_MEMORIES_DIR || resolvedPath.startsWith(`${CODEX_MEMORIES_DIR}${path.sep}`)) {
    return true;
  }

  if (
    (resolvedPath === CLAUDE_PROJECTS_DIR || resolvedPath.startsWith(`${CLAUDE_PROJECTS_DIR}${path.sep}`)) &&
    resolvedPath.includes(`${path.sep}memory${path.sep}`)
  ) {
    return true;
  }

  return false;
}

// Keep quoted text as one shell word: quoted paths and quoted subcommands stay intact, and text
// arguments such as `echo "git push …"` are not re-split into executable-looking words. These words
// feed deny/ask scans only, so a failed strict parse widens the view instead of emptying it (rounds
// 16/17: `>|`, `<>`, `case … ;;` erased the credential path and a deny decayed into an ask). Approval
// proofs keep the strict view in commandAllowProof.
const commandWords = (command: string): string[] => tokenizeCommandWords(command) ?? lenientCommandWords(command);

function commandProgram(word: string | undefined): string {
  return word ? path.posix.basename(word) : '';
}

function gitCommand(command: string): { subcommand: string; args: string[] } | null {
  const words = commandWords(command);
  if (!words) return null;
  const gitIndex = words.findIndex((word) => commandProgram(word) === 'git');
  if (gitIndex < 0) return null;
  let index = gitIndex + 1;
  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(option)) index += 2;
    else index += 1;
  }
  if (index >= words.length) return null;
  return { subcommand: words[index], args: words.slice(index + 1) };
}

export function gitMutationReason(command: string): string | null {
  const git = gitCommand(command);
  if (!git) return null;
  if (git.subcommand === 'push') return 'git push 会写入远端';
  if (git.subcommand === 'remote') {
    const action = git.args.find((arg) => !arg.startsWith('-'));
    return action && ['set-url', 'add', 'rename'].includes(action)
      ? '修改 git 远端配置'
      : null;
  }
  if (git.subcommand !== 'config') return null;

  const readFlags = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope']);
  const mutationFlags = new Set(['--add', '--replace-all', '--unset', '--unset-all', '--remove-section', '--rename-section']);
  const optionsWithValue = new Set(['--file', '-f', '--blob', '--type', '--default']);
  let hasReadFlag = false;
  let hasMutationFlag = false;
  const operands: string[] = [];
  for (let index = 0; index < git.args.length; index += 1) {
    const arg = git.args[index];
    if (readFlags.has(arg)) {
      hasReadFlag = true;
      continue;
    }
    if (mutationFlags.has(arg)) {
      hasMutationFlag = true;
      continue;
    }
    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    operands.push(arg);
  }
  const key = operands[0]?.toLowerCase();
  if (!key) return null;
  const protectedKey = /^url\..+\.(?:push)?insteadof$/i.test(key)
    || /^credential(?:\.|$)/i.test(key)
    || key === 'core.sshcommand'
    || key === 'http.proxy'
    || key === 'https.proxy';
  return protectedKey && !hasReadFlag && (hasMutationFlag || operands.length >= 2)
    ? '修改 git 远端或凭据配置'
    : null;
}

export function credentialReadTarget(command: string, context: ClassificationContext): string | null {
  const words = commandWords(command);
  if (!words) return null;
  const projectRoot = resolveCanonicalRunPath(context.workspaceRoot ?? context.workingDirectory);
  const ignoredIndexes = new Set<number>();
  const grepIndex = words.findIndex((word) => ['grep', 'egrep', 'fgrep', 'rg'].includes(commandProgram(word)));
  if (grepIndex >= 0) {
    let patternProvidedByOption = false;
    for (let index = grepIndex + 1; index < words.length; index += 1) {
      const word = words[index];
      if (word === '-e' || word === '--regexp') {
        if (index + 1 < words.length) ignoredIndexes.add(index + 1);
        patternProvidedByOption = true;
        index += 1;
        continue;
      }
      if (word.startsWith('--regexp=')) {
        patternProvidedByOption = true;
        continue;
      }
      if (!word.startsWith('-') && !patternProvidedByOption) {
        ignoredIndexes.add(index);
        break;
      }
    }
  }
  // Redirection operands (`> f`, `< f`) are path candidates too: `> $'\0'` must stay a refusal and
  // `cat < "$HOME/.ssh/id_rsa"` a credential read. resolveCandidatePath expands $HOME itself, so an
  // uncertain operand is scanned like any other word — dropping it let that read go unasked (round 18).
  const parsed = parseShellCommand(command);
  const targets = [...parsed.writeTargets, ...parsed.segments.flatMap((segment) => segment.reads)].map((o) => o.path);
  for (const rawCandidate of [...words.filter((word, index) => word && !ignoredIndexes.has(index)), ...targets]) {
    // dd 的操作数带 `if=`/`of=` 前缀，整词当路径解析永远不命中——`dd if=.env …` 读的是凭据（N-APPROVAL-DRYRUN-DD）
    const candidate = /^(?:if|of)=/.test(rawCandidate) ? rawCandidate.slice(3) : rawCandidate;
    const resolved = resolveCandidatePath(candidate, context.workingDirectory, context.pathResolutionCache);
    if (isSensitiveCredentialPath(resolved, { homeDir: CANONICAL_HOME_DIR, projectRoot })) return resolved;
  }
  return null;
}

export function recursivelyRemovesPath(command: string): boolean {
  const words = commandWords(command);
  const rmIndex = words.findIndex((word) => commandProgram(word) === 'rm');
  return rmIndex >= 0 && words.slice(rmIndex + 1).some((arg) => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg));
}

// npm config 语义：同名参数后者覆盖前者，`--no-dry-run` / `--dry-run=false` 会把前面的 `--dry-run` 关掉——
// `npm publish --dry-run --no-dry-run` 是真发布。只查 includes('--dry-run') 会把它当预览放行（N-APPROVAL-DRYRUN-DD，review-eval 在 #1611 案例上报出）。
function npmPublishDryRunFlag(words: string[], start: number): boolean {
  // ponytail: 只认写全的 --dry-run / --no-dry-run（含 =值、紧跟 true/false 取值）。
  // npm 实测：`--dry-run false` 把 false 吃成取值 ⇒ 真发布；且任意唯一前缀缩写都被展开（--dry、--no-dr、--dry=false），
  // 缩写形一律当拿不准 ⇒ 不放行（落到 ask），比逐个列举更稳。
  let dryRun = false;
  const rest = words.slice(start);
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    const eq = word.indexOf('=');
    // nopt 把任意数量的前导短横都当 --（实测 `---no-dry-run` 关掉预览 ⇒ 真发布），先归一再比
    const flag = (eq === -1 ? word : word.slice(0, eq)).replace(/^-{2,}/, '--');
    let value = eq === -1 ? undefined : word.slice(eq + 1);
    if (flag !== '--dry-run' && flag !== '--no-dry-run') {
      if (/^-+(no-)?d/.test(flag)) return false;
      continue;
    }
    if (value === undefined && (rest[i + 1] === 'true' || rest[i + 1] === 'false')) value = rest[++i];
    dryRun = flag === '--dry-run' && (value === undefined || value === 'true');
  }
  return dryRun;
}

export function isNpmPublishDryRun(command: string): boolean {
  const words = anchoredAllowCommandWords(command, 'npm');
  return words !== null && words[1] === 'publish' && npmPublishDryRunFlag(words, 2);
}

export function ddCopiesWorkspaceFile(command: string, context: ClassificationContext): boolean {
  const words = anchoredAllowCommandWords(command, 'dd');
  if (!words) return false;

  const input = words.slice(1).find((word) => word.startsWith('if='))?.slice(3);
  const output = words.slice(1).find((word) => word.startsWith('of='))?.slice(3);
  if (!input || !output) return false;

  const workspace = resolveCanonicalRunPath(context.workspaceRoot ?? context.workingDirectory);
  const resolvedInput = resolveCandidatePath(input, context.workingDirectory, context.pathResolutionCache);
  const resolvedOutput = resolveCandidatePath(output, context.workingDirectory, context.pathResolutionCache);
  // 工作区内的 .env* 也是凭据：`dd if=.env of=copy.bin` 是把凭据复制进工作区文件，不是普通文件搬运（N-APPROVAL-DRYRUN-DD）
  if (isSensitiveCredentialPath(resolvedInput, { homeDir: CANONICAL_HOME_DIR, projectRoot: workspace })) return false;
  return isPathInside(resolvedInput, workspace) && isPathInside(resolvedOutput, workspace);
}

export function hasPositiveAllowCandidate(command: string): boolean {
  const words = commandWords(command);
  if (!words) return false;
  const npmIndex = words.findIndex((word) => commandProgram(word) === 'npm');
  if (npmIndex >= 0 && words[npmIndex + 1] === 'publish' && npmPublishDryRunFlag(words, npmIndex + 2)) return true;

  const ddIndex = words.findIndex((word) => commandProgram(word) === 'dd');
  return ddIndex >= 0
    && words.slice(ddIndex + 1).some((word) => word.startsWith('if='))
    && words.slice(ddIndex + 1).some((word) => word.startsWith('of='));
}

export function readPathCandidates(toolName: string, args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([key, value]) => {
      if (typeof value !== 'string' || (!value.trim() && !value.includes('\0'))) return false;
      return key.includes('path') || (normalizeToolName(toolName).toLowerCase() === 'glob' && key === 'pattern');
    })
    .map(([, value]) => value as string);
}

export function contextAfterCdSegment(
  segment: string, context: ClassificationContext,
  terminators: SegmentTerminator[], segmentIndex: number,
): ClassificationContext | null {
  const words = commandWords(segment);
  if (!words) return null;
  if (commandProgram(words[0]) !== 'cd') return null;
  // `&`/pipeline members run in subshells: the parent shell's cwd never moved, so later segments
  // keep the original cwd. `||` does carry: its right side only runs after a failed cd, but once
  // the chain ends the cd-succeeded outcome has already moved the shell — of the two possible
  // cwds only the moved one is reconstructable here, and it is the one the baseline resolves
  // against. Checking both cwds would be stricter still; deliberately not done (round 33).
  if (![null, ';', '&&', '||', '\n'].includes(terminators[segmentIndex] ?? null)) return null;
  // A cd that is itself a pipeline member (`true | cd /tmp`) runs in the pipeline's subshell;
  // the parent cwd never moved. Only the terminator after it was checked above — also look back.
  if (['|', '|&'].includes(terminators[segmentIndex - 1] ?? '')) return null;
  // Round 35/36: `&` backgrounds the whole AND/OR list, cd included (`cd /tmp && env & …`).
  // `|&` is only a pipe (`2>&1 |`), not a background operator: `cd ~ && true |& cat` still runs
  // the cd in the parent shell, so it must not block propagation.
  const listEnd = listTerminatorAfter(terminators, segmentIndex);
  if (listEnd === '&') return null;

  const args = words.slice(1);
  const separator = args.indexOf('--');
  const candidates = (separator >= 0 ? args.slice(separator + 1) : args).filter((arg) => !arg.startsWith('-'));
  const target = candidates[0] ?? '~';
  // `cd -` depends on shell history, so its successor cwd cannot be reconstructed here.
  if (target === '-') return context;
  return {
    ...context,
    workingDirectory: resolveCandidatePath(target, context.workingDirectory, context.pathResolutionCache),
  };
}

/**
 * P0 safe-command bypass must not skip actions whose arguments change the
 * permission decision. Keep this predicate beside the classifier rules so the
 * fast path and full classification cannot drift.
 */
export function bashCommandRequiresPermission(
  command: string,
  context: Pick<ClassificationContext, 'workingDirectory' | 'workspaceRoot'>,
): boolean {
  try {
    // Segmentation needs the original quotes: code arguments may contain shell operators.
    const segments = splitCompoundCommand(command);
    if (!segments) return true;
    // splitCompoundCommand rebuilds these one-for-one from the same parse's segments.
    const terminators = parseShellCommand(command).segments.map((segment) => segment.terminator);
    let segmentContext: ClassificationContext = {
      ...context,
      permissionLevel: 'execute',
      pathResolutionCache: new Map(),
    };
    return segments.some((segment, index) => {
      const advancedContext = contextAfterCdSegment(segment, segmentContext, terminators, index);
      if (advancedContext) {
        segmentContext = advancedContext;
        return false;
      }
      return credentialReadTarget(segment, segmentContext) !== null
        || gitMutationReason(segment) !== null
        || resolvedRmCriticalTarget(segment, segmentContext) !== null
        || hasPositiveAllowCandidate(segment);
    });
  } catch {
    return true;
  }
}
