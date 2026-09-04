import * as path from 'node:path';
import { parse } from 'shell-quote';
import { canonicalizeCommand } from './canonicalizeCommand';

const COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>&']);
const SHELL_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'dash']);
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas']);
const SIMPLE_WRAPPERS = new Set(['command', 'exec', 'nohup', 'setsid']);
const MAX_WRAPPER_DEPTH = 4;

interface ParsedShellSegment {
  words: string[];
}

interface ShellWriteTarget {
  path: string;
  source: 'redirect' | 'sed-in-place' | 'tee' | 'copy' | 'move';
  uncertain: boolean;
}

export interface ShellExecution {
  program: string;
  args: string[];
  originalProgram: string;
  wrappers: string[];
}

export interface ParsedShellCommand {
  segments: ParsedShellSegment[];
  writeTargets: ShellWriteTarget[];
  executions: ShellExecution[];
  parsingFailed: boolean;
  failureReason?: string;
  uncertain: string[];
  trailingOperator: boolean;
}

type ShellOperator = { op: string };
type ShellGlob = { op: 'glob'; pattern: string };
type ShellEntry = string | ShellOperator | ShellGlob | { comment: string };

function isOperator(entry: ShellEntry): entry is ShellOperator {
  return typeof entry === 'object' && entry !== null && 'op' in entry;
}

function normalizeWord(word: string): { word: string; failed: boolean } {
  // shell-quote treats ANSI-C words as a literal `$` prefix plus escaped content.
  // Re-wrap that representation before sending it through the existing decoder.
  const source = word.startsWith('${}')
    ? `$'${word.slice(3)}'`
    : word.startsWith('$\\')
      ? `$'${word.slice(1)}'`
      : null;
  if (source === null) return { word, failed: false };
  const canonical = canonicalizeCommand(source);
  return { word: canonical.command, failed: canonical.parsingFailed };
}

function entryWord(entry: ShellEntry): { word: string; uncertain: boolean } | null {
  if (typeof entry === 'string') {
    const normalized = normalizeWord(entry);
    return {
      word: normalized.word,
      uncertain: normalized.failed || /[$`*?{}]/.test(normalized.word),
    };
  }
  if (isOperator(entry) && entry.op === 'glob' && 'pattern' in entry) {
    return { word: String((entry as ShellGlob).pattern), uncertain: true };
  }
  return null;
}

function basename(program: string): string {
  return path.posix.basename(program.replaceAll('\\', '/'));
}

function removeShellLineContinuations(command: string): string {
  let result = '';
  let quoteMode: 'plain' | 'single' | 'double' | 'ansi' = 'plain';
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '\\' && quoteMode !== 'single' && quoteMode !== 'ansi') {
      if (command[index + 1] === '\n') {
        index += 1;
        continue;
      }
      if (command[index + 1] === '\r' && command[index + 2] === '\n') {
        index += 2;
        continue;
      }
      result += character;
      if (command[index + 1] !== undefined) result += command[++index];
      continue;
    }
    if (quoteMode === 'plain' && character === '$' && command[index + 1] === "'") {
      quoteMode = 'ansi';
      result += `${character}${command[++index]}`;
      continue;
    }
    if (character === "'" && (quoteMode === 'plain' || quoteMode === 'single')) {
      quoteMode = quoteMode === 'single' ? 'plain' : 'single';
    } else if (character === '"' && (quoteMode === 'plain' || quoteMode === 'double')) {
      quoteMode = quoteMode === 'double' ? 'plain' : 'double';
    } else if (character === "'" && quoteMode === 'ansi') {
      quoteMode = 'plain';
    }
    result += character;
  }
  return result;
}

function optionCommandIndex(
  args: string[],
  valueOptions: ReadonlySet<string>,
  options?: { assignments?: boolean; skipDuration?: boolean },
): number | null {
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return index + 1 < args.length ? index + 1 : null;
    if (options?.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (!arg.startsWith('-') || arg === '-') break;
    const optionName = arg.split('=', 1)[0];
    if (valueOptions.has(optionName) && !arg.includes('=')) index += 1;
  }
  if (options?.skipDuration) index += 1;
  return index < args.length ? index : null;
}

function parseEnvSplitWords(value: string): { words: string[]; failed?: string } {
  let entries: ShellEntry[];
  try {
    entries = parse(removeShellLineContinuations(value), (key) => `\${${key}}`) as ShellEntry[];
  } catch (error) {
    return { words: [], failed: error instanceof Error ? error.message : String(error) };
  }

  const words: string[] = [];
  for (const entry of entries) {
    const word = entryWord(entry);
    if (!word || word.uncertain) {
      return { words: [], failed: 'env --split-string contains a non-literal word' };
    }
    words.push(word.word);
  }
  return words.length > 0
    ? { words }
    : { words: [], failed: 'env --split-string is empty' };
}

function expandEnvSplitStrings(args: string[]): { args: string[]; failed?: string } {
  const expanded = [...args];
  for (let expansion = 0; expansion <= MAX_WRAPPER_DEPTH; expansion += 1) {
    let splitIndex = -1;
    let splitValue: string | undefined;
    let consumed = 1;

    for (let index = 0; index < expanded.length; index += 1) {
      const arg = expanded[index];
      if (arg === '--') break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
      if (arg === '-S' || arg === '--split-string') {
        splitIndex = index;
        splitValue = expanded[index + 1];
        consumed = 2;
        break;
      }
      if (arg.startsWith('--split-string=')) {
        splitIndex = index;
        splitValue = arg.slice('--split-string='.length);
        break;
      }
      if (arg.startsWith('-S') && arg.length > 2) {
        splitIndex = index;
        splitValue = arg.slice(2);
        break;
      }
      if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') {
        index += 1;
        continue;
      }
      if (arg.startsWith('-')) continue;
      break;
    }

    if (splitIndex < 0) return { args: expanded };
    if (splitValue === undefined) {
      return { args: expanded, failed: 'env --split-string requires a value' };
    }
    const parsed = parseEnvSplitWords(splitValue);
    if (parsed.failed) return { args: expanded, failed: parsed.failed };
    expanded.splice(splitIndex, consumed, ...parsed.words);
  }
  return { args: expanded, failed: 'env --split-string expansion exceeds 4 levels' };
}

function wrapperCommandIndex(program: string, args: string[]): number | null {
  if (PRIVILEGE_WRAPPERS.has(program)) {
    return optionCommandIndex(args, new Set([
      '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
      '-C', '--close-from', '-R', '--chroot', '-T', '--command-timeout',
    ]));
  }
  if (program === 'env') {
    return optionCommandIndex(args, new Set([
      '-u', '--unset', '-C', '--chdir', '-S', '--split-string',
    ]), { assignments: true });
  }
  if (SIMPLE_WRAPPERS.has(program)) {
    return optionCommandIndex(args, new Set(program === 'exec' ? ['-a'] : []));
  }
  if (program === 'nice') {
    return optionCommandIndex(args, new Set(['-n', '--adjustment']));
  }
  if (program === 'timeout') {
    return optionCommandIndex(args, new Set(['-k', '--kill-after', '-s', '--signal']), {
      skipDuration: true,
    });
  }
  if (program === 'xargs') {
    return optionCommandIndex(args, new Set([
      '-E', '--eof', '-I', '--replace', '-L', '--max-lines', '-n', '--max-args',
      '-P', '--max-procs', '-s', '--max-chars', '-a', '--arg-file',
    ]));
  }
  if (program === 'busybox') return optionCommandIndex(args, new Set([]));
  return null;
}

function shellScript(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c' || /^-[^-]*c[^-]*$/.test(args[index])) {
      return args[index + 1] ?? null;
    }
  }
  return null;
}

function sedTargets(words: string[]): ShellWriteTarget[] {
  const args = words.slice(1);
  const inPlace = args.some((arg) => arg === '-i' || arg.startsWith('-i')
    || arg === '--in-place' || arg.startsWith('--in-place='));
  if (!inPlace) return [];

  let scriptSeen = false;
  let optionConsumesValue = false;
  const files: string[] = [];
  for (const arg of args) {
    if (optionConsumesValue) {
      optionConsumesValue = false;
      if (!scriptSeen) scriptSeen = true;
      continue;
    }
    if (arg === '-e' || arg === '--expression' || arg === '-f' || arg === '--file') {
      optionConsumesValue = true;
      continue;
    }
    if (arg === '-i' || arg === '--in-place' || arg.startsWith('-i') || arg.startsWith('--in-place=')) {
      continue;
    }
    if (arg.startsWith('-') && !scriptSeen) continue;
    if (!scriptSeen) {
      scriptSeen = true;
      continue;
    }
    files.push(arg);
  }
  return files.map((target) => ({
    path: target,
    source: 'sed-in-place',
    uncertain: /[$`*?{}]/.test(target),
  }));
}

function commandWriteTargets(execution: ShellExecution): ShellWriteTarget[] {
  const words = [execution.program, ...execution.args];
  if (execution.program === 'sed') return sedTargets(words);
  if (execution.program === 'tee') {
    return execution.args.filter((arg) => arg !== '--' && !arg.startsWith('-')).map((target) => ({
      path: target,
      source: 'tee' as const,
      uncertain: /[$`*?{}]/.test(target),
    }));
  }
  if (execution.program !== 'cp' && execution.program !== 'mv') return [];

  const targetDirectoryIndex = execution.args.findIndex((arg) => arg === '-t' || arg === '--target-directory');
  const attachedTargetDirectory = execution.args.find((arg) => arg.startsWith('--target-directory='))
    ?.slice('--target-directory='.length);
  const target = attachedTargetDirectory || (targetDirectoryIndex >= 0
    ? execution.args[targetDirectoryIndex + 1]
    : execution.args.filter((arg) => arg === '-' || !arg.startsWith('-')).at(-1));
  return target ? [{
    path: target,
    source: execution.program === 'cp' ? 'copy' : 'move',
    uncertain: /[$`*?{}]/.test(target),
  }] : [];
}

function parseEntries(command: string): {
  segments: ParsedShellSegment[];
  redirects: ShellWriteTarget[];
  failed: boolean;
  failureReason?: string;
  trailingOperator: boolean;
} {
  const canonical = canonicalizeCommand(command);
  let entries: ShellEntry[];
  try {
    entries = parse(removeShellLineContinuations(command), (key) => `\${${key}}`) as ShellEntry[];
  } catch (error) {
    return {
      segments: [], redirects: [], failed: true,
      failureReason: error instanceof Error ? error.message : String(error),
      trailingOperator: false,
    };
  }

  const segments: ParsedShellSegment[] = [];
  const redirects: ShellWriteTarget[] = [];
  let words: string[] = [];
  let trailingOperator = false;
  let failed = canonical.parsingFailed;
  let failureReason = canonical.failureReason;

  const flush = (): void => {
    if (words.length > 0) segments.push({ words });
    words = [];
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (isOperator(entry) && entry.op === 'glob' && 'pattern' in entry) {
      words.push(String((entry as ShellGlob).pattern));
      continue;
    }
    if (isOperator(entry) && OUTPUT_REDIRECTS.has(entry.op)) {
      const target = entryWord(entries[index + 1]);
      if (!target) {
        failed = true;
        failureReason ??= `missing redirection target after ${entry.op}`;
        continue;
      }
      index += 1;
      if (entry.op === '>&' && /^(?:\d+|-)$/.test(target.word)) continue;
      redirects.push({ path: target.word, source: 'redirect', uncertain: target.uncertain });
      continue;
    }
    if (isOperator(entry) && COMMAND_SEPARATORS.has(entry.op)) {
      // shell-quote emits `&`, `>` for the `&>file` redirection spelling.
      const nextEntry = entries[index + 1];
      if (entry.op === '&' && nextEntry !== undefined && isOperator(nextEntry) && nextEntry.op === '>') {
        continue;
      }
      flush();
      trailingOperator = index === entries.length - 1;
      continue;
    }
    if (isOperator(entry)) {
      failed = true;
      failureReason ??= `unsupported shell operator: ${entry.op}`;
      continue;
    }
    const word = entryWord(entry);
    if (word) words.push(word.word);
  }
  flush();
  return { segments, redirects, failed, failureReason, trailingOperator };
}

function expandExecutions(
  words: string[],
  originalProgram: string,
  wrappers: string[],
  depth: number,
): { executions: ShellExecution[]; targets: ShellWriteTarget[]; uncertain: string[]; failed?: string } {
  if (words.length === 0) return { executions: [], targets: [], uncertain: [] };
  if (depth > MAX_WRAPPER_DEPTH) {
    return { executions: [], targets: [], uncertain: [], failed: 'shell wrapper depth exceeds 4' };
  }

  const program = basename(words[0]);
  let args = words.slice(1);
  if (program === 'env') {
    const split = expandEnvSplitStrings(args);
    if (split.failed) {
      return { executions: [], targets: [], uncertain: [], failed: split.failed };
    }
    args = split.args;
  }
  if (SHELL_PROGRAMS.has(program)) {
    const script = shellScript(args);
    if (!script) {
      return { executions: [{ program, args, originalProgram, wrappers }], targets: [], uncertain: [] };
    }
    return expandCommand(script, originalProgram, [...wrappers, program], depth + 1);
  }
  if (program === 'eval') {
    return args.length === 0
      ? { executions: [{ program, args, originalProgram, wrappers }], targets: [], uncertain: [] }
      : expandCommand(args.join(' '), originalProgram, [...wrappers, program], depth + 1);
  }

  const commandIndex = wrapperCommandIndex(program, args);
  if (commandIndex !== null) {
    const nested = args.slice(commandIndex);
    if (nested.length === 0) {
      return { executions: [], targets: [], uncertain: [`wrapper-without-command:${program}`] };
    }
    return expandExecutions(nested, originalProgram, [...wrappers, program], depth + 1);
  }

  const execution = { program, args, originalProgram, wrappers };
  const dynamicProgram = /[$`*?{}]/.test(program);
  // An unknown launcher (chronic, doas, a project wrapper…) can hide a whole shell script behind
  // itself. Marking it uncertain is not enough: the path policy only consults extracted targets, so
  // `chronic bash -c 'echo x > src/x.ts'` would write through an Edit(src/**) deny. Keep scanning
  // from the shell word so the real target reaches the policy, and keep the uncertain marker too —
  // we still cannot know what the launcher itself does.
  const shellLauncherIndex = args.findIndex((arg, index) => SHELL_PROGRAMS.has(basename(arg))
    && args.slice(index + 1).some((candidate) => candidate === '-c' || /^-[^-]*c[^-]*$/.test(candidate)));
  const launcherUncertain = [
    ...(dynamicProgram ? [`dynamic-command-position:${program}`] : []),
    ...(shellLauncherIndex >= 0 ? [`unknown-shell-launcher:${program}`] : []),
  ];
  if (shellLauncherIndex >= 0) {
    const nested = expandExecutions(
      args.slice(shellLauncherIndex),
      originalProgram,
      [...wrappers, program],
      depth + 1,
    );
    return {
      executions: [execution, ...nested.executions],
      targets: [...commandWriteTargets(execution), ...nested.targets],
      uncertain: [...launcherUncertain, ...nested.uncertain],
      ...(nested.failed ? { failed: nested.failed } : {}),
    };
  }
  return {
    executions: [execution],
    targets: commandWriteTargets(execution),
    uncertain: launcherUncertain,
  };
}

function expandCommand(
  command: string,
  originalProgram: string,
  wrappers: string[],
  depth: number,
): { executions: ShellExecution[]; targets: ShellWriteTarget[]; uncertain: string[]; failed?: string } {
  const parsed = parseEntries(command);
  if (parsed.failed) {
    return { executions: [], targets: parsed.redirects, uncertain: [], failed: parsed.failureReason };
  }
  const expanded = parsed.segments.map((segment) =>
    expandExecutions(segment.words, originalProgram, wrappers, depth));
  return {
    executions: expanded.flatMap((item) => item.executions),
    targets: [...parsed.redirects, ...expanded.flatMap((item) => item.targets)],
    uncertain: expanded.flatMap((item) => item.uncertain),
    failed: expanded.find((item) => item.failed)?.failed,
  };
}

export function parseShellCommand(command: string): ParsedShellCommand {
  const parsed = parseEntries(command);
  const expanded = parsed.segments.map((segment) => {
    const originalProgram = basename(segment.words[0] ?? '');
    return expandExecutions(segment.words, originalProgram, [], 0);
  });
  const failed = parsed.failureReason ?? expanded.find((item) => item.failed)?.failed;
  return {
    segments: parsed.segments,
    writeTargets: [...parsed.redirects, ...expanded.flatMap((item) => item.targets)],
    executions: expanded.flatMap((item) => item.executions),
    parsingFailed: parsed.failed || Boolean(failed),
    ...(failed ? { failureReason: failed } : {}),
    uncertain: [...new Set(expanded.flatMap((item) => item.uncertain))],
    trailingOperator: parsed.trailingOperator,
  };
}

export function commandWordsFromParse(command: string): string[] | null {
  const parsed = parseShellCommand(command);
  return parsed.parsingFailed || parsed.segments.length !== 1 || parsed.trailingOperator
    ? null
    : parsed.segments[0].words;
}

export function resolvedExecutable(command: string): ShellExecution | null {
  const parsed = parseShellCommand(command);
  return parsed.parsingFailed || parsed.uncertain.length > 0 || parsed.executions.length !== 1
    ? null
    : parsed.executions[0];
}

export function hasPrivilegedOrEvalWrapper(execution: ShellExecution): boolean {
  return execution.wrappers.some((wrapper) => PRIVILEGE_WRAPPERS.has(wrapper) || wrapper === 'eval');
}
