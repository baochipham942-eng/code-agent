import * as path from 'node:path';
import { parse } from 'shell-quote';
import { canonicalizeCommand } from './canonicalizeCommand';

const COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n']);
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
  /** Assignment values can change lookup, loader behavior or shell startup. Never discard them. */
  environmentAssignments?: string[];
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

function shellLines(command: string): string[] {
  const lines: string[] = [];
  let result = '';
  let quoteMode: 'plain' | 'single' | 'double' | 'ansi' = 'plain';
  let inComment = false;
  let atWordStart = true;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (inComment) {
      if (character === '\n') {
        lines.push(result);
        result = '';
        inComment = false;
        atWordStart = true;
      } else result += character;
      continue;
    }
    // shell-quote does not distinguish IO numbers from operands. Drop only a plain,
    // whole numeric word attached to a redirect; quoted/escaped digits and `2 > f` stay data.
    if (quoteMode === 'plain' && atWordStart && /[0-9]/.test(character)) {
      const ioNumber = command.slice(index).match(/^[0-9]+(?=[<>])/);
      if (ioNumber) {
        index += ioNumber[0].length - 1;
        continue;
      }
    }
    if (quoteMode === 'plain' && character === '#'
      && (index === 0 || /[\s;&|()<>]/.test(command[index - 1]))) {
      inComment = true;
      result += character;
      continue;
    }
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
      atWordStart = false;
      continue;
    }
    if (quoteMode === 'ansi' && character === '\\') {
      result += character;
      if (command[index + 1] !== undefined) result += command[++index];
      atWordStart = false;
      continue;
    }
    if (quoteMode === 'plain' && character === '\n') {
      lines.push(result);
      result = '';
      atWordStart = true;
      continue;
    }
    if (quoteMode === 'plain' && character === '$' && command[index + 1] === "'") {
      quoteMode = 'ansi';
      atWordStart = false;
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
    atWordStart = quoteMode === 'plain' && /[\s;|&()]/.test(character)
      && !(character === '&' && /[<>]/.test(command[index - 1] ?? ''));
    result += character;
  }
  lines.push(result);
  return lines;
}

/**
 * Where the wrapped command starts, or 'unresolved' when an option we do not know appears.
 *
 * Treating an unknown option as a boolean flag is a bypass, not a guess: `sudo -D all@debug tee
 * ~/.ssh/authorized_keys` would make `all@debug` the program and `tee`'s target would never reach
 * the path policy. Both tables below are therefore allowlists — forgetting an option costs an extra
 * approval card (fail closed), never a silent write through an Edit(...) / denied_paths deny.
 */
function optionCommandIndex(
  args: string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
  options?: { assignments?: boolean; skipDuration?: boolean; numericFlags?: boolean },
): number | null | 'unresolved' {
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return index + 1 < args.length ? index + 1 : null;
    if (options?.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (!arg.startsWith('-') || arg === '-') break;
    if (options?.numericFlags && /^-\d+$/.test(arg)) continue;
    const optionName = arg.split('=', 1)[0];
    if (valueOptions.has(optionName)) {
      if (!arg.includes('=')) index += 1;
      continue;
    }
    if (booleanOptions.has(optionName)) continue;
    // A cluster of short boolean flags (`sudo -En`) is still fully understood.
    if (/^-[A-Za-z0-9]+$/.test(arg)
      && [...arg.slice(1)].every((letter) => booleanOptions.has(`-${letter}`))) continue;
    return 'unresolved';
  }
  if (options?.skipDuration) index += 1;
  return index < args.length ? index : null;
}

function parseEnvSplitWords(value: string): { words: string[]; failed?: string } {
  let entries: ShellEntry[];
  try {
    entries = parse(shellLines(value).join('\n'), (key) => `\${${key}}`) as ShellEntry[];
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

function wrapperCommandIndex(program: string, args: string[]): number | null | 'unresolved' {
  if (PRIVILEGE_WRAPPERS.has(program)) {
    return optionCommandIndex(args, new Set([
      '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
      '-C', '--close-from', '-R', '--chroot', '-T', '--command-timeout',
      '-D', '--chdir', '-U', '--other-user', '-r', '--role', '-t', '--type',
      '-a', '--auth-type',
    ]), new Set([
      '-A', '--askpass', '-b', '--background', '-E', '--preserve-env', '-H', '--set-home',
      '-i', '--login', '-K', '--remove-timestamp', '-k', '--reset-timestamp', '-l', '--list',
      '-n', '--non-interactive', '-P', '--preserve-groups', '-S', '--stdin', '-s', '--shell',
      '-V', '--version', '-v', '--validate', '-L', '--help',
    ]));
  }
  if (program === 'env') {
    return optionCommandIndex(args, new Set([
      '-u', '--unset', '-C', '--chdir', '-S', '--split-string',
    ]), new Set([
      '-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '--help', '--version',
    ]), { assignments: true });
  }
  if (SIMPLE_WRAPPERS.has(program)) {
    return optionCommandIndex(
      args,
      new Set(program === 'exec' ? ['-a'] : []),
      new Set(program === 'exec' ? ['-c', '-l'] : ['-p']),
    );
  }
  if (program === 'nice') {
    return optionCommandIndex(args, new Set(['-n', '--adjustment']), new Set(['--help', '--version']), {
      numericFlags: true,
    });
  }
  if (program === 'timeout') {
    return optionCommandIndex(
      args,
      new Set(['-k', '--kill-after', '-s', '--signal']),
      new Set(['--foreground', '--preserve-status', '-v', '--verbose', '--help', '--version']),
      { skipDuration: true },
    );
  }
  if (program === 'xargs') {
    return optionCommandIndex(args, new Set([
      '-E', '--eof', '-I', '--replace', '-L', '--max-lines', '-n', '--max-args',
      '-P', '--max-procs', '-s', '--max-chars', '-a', '--arg-file', '-d', '--delimiter',
    ]), new Set([
      '-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive',
      '-x', '--exit', '--help', '--version',
    ]));
  }
  if (program === 'busybox') return optionCommandIndex(args, new Set([]), new Set([]));
  return null;
}

function shellScript(args: string[]): { command: string } | { scriptIndex: number } | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return index + 1 < args.length ? { scriptIndex: index + 1 } : null;
    if (!arg.startsWith('-') && !arg.startsWith('+')) return { scriptIndex: index };
    if (arg === '-') return null;
    // Startup options consume their values before the command string or script operand.
    if (['--rcfile', '--init-file', '-o', '+o', '-O', '+O'].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg === '-c' || /^-[^-]*c[^-]*$/.test(arg)) {
      return args[index + 1] === undefined ? null : { command: args[index + 1] };
    }
    if (!['--norc', '--noprofile', '--posix', '--restricted', '--verbose', '--login'].includes(arg)
      && !/^[-+][abefhiklmnprstuvxBCEHPT]+$/.test(arg)) return null;
  }
  return null;
}

function sedTargets(words: string[]): ShellWriteTarget[] {
  const args = words.slice(1);
  const inPlaceArg = args.find((arg) => arg === '-i' || arg.startsWith('-i')
    || arg === '--in-place' || arg.startsWith('--in-place='));
  if (inPlaceArg === undefined) return [];
  // `sed -i.bak f` also creates `f.bak`; a deny on the suffix pattern (*.pem) has to see it.
  const backupSuffix = inPlaceArg.startsWith('--in-place=')
    ? inPlaceArg.slice('--in-place='.length)
    : inPlaceArg.startsWith('-i') ? inPlaceArg.slice(2) : '';

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
  return files.flatMap((target) => {
    const uncertain = /[$`*?{}]/.test(target);
    const entries: ShellWriteTarget[] = [{ path: target, source: 'sed-in-place', uncertain }];
    if (backupSuffix) {
      entries.push({
        path: `${target}${backupSuffix}`,
        source: 'sed-in-place',
        uncertain: uncertain || /[$`*?{}]/.test(backupSuffix),
      });
    }
    return entries;
  });
}

function commandWriteTargets(execution: ShellExecution): ShellWriteTarget[] {
  const program = basename(execution.program);
  const words = [program, ...execution.args];
  if (program === 'sed') return sedTargets(words);
  if (program === 'tee') {
    return execution.args.filter((arg) => arg !== '--' && !arg.startsWith('-')).map((target) => ({
      path: target,
      source: 'tee' as const,
      uncertain: /[$`*?{}]/.test(target),
    }));
  }
  if (program !== 'cp' && program !== 'mv') return [];

  const targetDirectoryIndex = execution.args.findIndex((arg) => arg === '-t' || arg === '--target-directory');
  const attachedTargetDirectory = execution.args.find((arg) => arg.startsWith('--target-directory='))
    ?.slice('--target-directory='.length);
  const target = attachedTargetDirectory || (targetDirectoryIndex >= 0
    ? execution.args[targetDirectoryIndex + 1]
    : execution.args.filter((arg) => arg === '-' || !arg.startsWith('-')).at(-1));
  return target ? [{
    path: target,
    source: program === 'cp' ? 'copy' : 'move',
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
    // shell-quote discards bare newlines; parse each unquoted line separately so
    // comments end at the line boundary too. Quoted newlines stay inside a word.
    entries = shellLines(command).flatMap((line, index) => [
      ...(index > 0 ? [{ op: '\n' }] : []),
      ...parse(line, (key) => `\${${key}}`) as ShellEntry[],
    ]);
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
      trailingOperator = entry.op !== '\n' && index === entries.length - 1;
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
  wordsInput: string[],
  originalProgram: string,
  wrappers: string[],
  depth: number,
): { executions: ShellExecution[]; targets: ShellWriteTarget[]; uncertain: string[]; failed?: string } {
  const words = wordsInput;
  if (words.length === 0) return { executions: [], targets: [], uncertain: [] };
  if (depth > MAX_WRAPPER_DEPTH) {
    return { executions: [], targets: [], uncertain: [], failed: 'shell wrapper depth exceeds 4' };
  }

  // `MODE=1 tee src/x.ts` — a segment may start with env assignments. Reading the first word as the
  // program makes `MODE=1` the program and tee's write target never reaches the path deny check.
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start += 1;
  if (start >= words.length) return { executions: [], targets: [], uncertain: [] };
  if (start > 0) {
    const nested = expandExecutions(words.slice(start), originalProgram, wrappers, depth);
    for (const execution of nested.executions) {
      execution.environmentAssignments = [...words.slice(0, start), ...(execution.environmentAssignments ?? [])];
    }
    return nested;
  }

  const program = words[0];
  const programName = basename(program);
  let args = words.slice(1);
  if (programName === 'env') {
    const split = expandEnvSplitStrings(args);
    if (split.failed) {
      return { executions: [], targets: [], uncertain: [], failed: split.failed };
    }
    args = split.args;
  }
  if (SHELL_PROGRAMS.has(programName)) {
    const script = shellScript(args);
    if (!script) {
      return { executions: [{ program, args, originalProgram, wrappers }], targets: [], uncertain: [] };
    }
    if ('scriptIndex' in script) {
      return {
        executions: [{ program: args[script.scriptIndex], args: args.slice(script.scriptIndex + 1),
          originalProgram, wrappers: [...wrappers, programName] }],
        targets: [],
        uncertain: ['shell-script-operand'],
      };
    }
    return expandCommand(script.command, originalProgram, [...wrappers, programName], depth + 1);
  }
  if (programName === 'eval') {
    return args.length === 0
      ? { executions: [{ program, args, originalProgram, wrappers }], targets: [], uncertain: [] }
      : expandCommand(args.join(' '), originalProgram, [...wrappers, programName], depth + 1);
  }

  const commandIndex = wrapperCommandIndex(programName, args);
  if (commandIndex === 'unresolved') {
    // We cannot tell where the wrapped command starts, so we must not guess a program: any write
    // target after the option we failed to read would silently skip the path policy.
    return {
      executions: [],
      targets: [],
      uncertain: [],
      failed: `${program} option arity is not known`,
    };
  }
  if (commandIndex !== null) {
    const nested = args.slice(commandIndex);
    if (nested.length === 0) {
      return { executions: [], targets: [], uncertain: [`wrapper-without-command:${program}`] };
    }
    const expanded = expandExecutions(nested, originalProgram, [...wrappers, programName], depth + 1);
    if (programName === 'env') {
      const assignments = args.slice(0, commandIndex).filter((arg) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
      if (assignments.length > 0) {
        for (const execution of expanded.executions) {
          execution.environmentAssignments = [...assignments, ...(execution.environmentAssignments ?? [])];
        }
      }
    }
    return expanded;
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
    const originalProgram = segment.words[0] ?? '';
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
