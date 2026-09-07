import * as path from 'node:path';
import { parse } from 'shell-quote';
import { canonicalizeCommand, decodeAnsiCQuotedBody } from './canonicalizeCommand';

const COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>&']);
const INPUT_REDIRECTS = new Set(['<', '<<<', '<&']);
const SHELL_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'dash']);
// Approval qualification intentionally mirrors the pre-parser baseline.  Only a
// bare bash/sh/zsh whose first argument is exactly -c/-lc may lend its inner
// command an approval identity.  The full parser above remains broader for
// write-target extraction.
const QUALIFICATION_SHELLS = new Set(['bash', 'sh', 'zsh']);
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas']);
const SIMPLE_WRAPPERS = new Set(['command', 'exec', 'nohup', 'setsid']);
const MAX_WRAPPER_DEPTH = 4;

/**
 * Separator immediately after a segment. Only `;`, `&&` and a newline let a preceding `cd`
 * move the parent shell's cwd: `&` and pipeline members (`|`, `|&`) run in subshells, and the
 * `||` successor only runs after a failed (cwd-preserving) cd. `null` = last segment.
 */
export type SegmentTerminator = ';' | '&&' | '||' | '\n' | '&' | '|' | '|&' | null;

interface ParsedShellSegment {
  words: string[];
  /** Output redirections attached to this segment. Also collected into `writeTargets`. */
  redirects: ShellWriteTarget[];
  /** Files read through `<`. Not writes, but path candidates for the credential scan. */
  reads: Array<{ path: string; uncertain: boolean }>;
  terminator: SegmentTerminator;
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

function entryWord(entry: ShellEntry): { word: string; uncertain: boolean } | null {
  if (typeof entry === 'string') return { word: entry, uncertain: /[$`*?{}]/.test(entry) };
  if (isOperator(entry) && entry.op === 'glob' && 'pattern' in entry) {
    return { word: String((entry as ShellGlob).pattern), uncertain: true };
  }
  return null;
}

function basename(program: string): string {
  return path.posix.basename(program.replaceAll('\\', '/'));
}

function shellLines(command: string): string[] {
  // Bash deletes an unquoted `\<LF>` before it reads words, so every look-ahead below — IO
  // numbers, `$'`, `#` boundaries, `&>` adjacency — must observe the merged text. `\<CR>` is no
  // continuation at all: bash reads it as an escaped CR word byte and the LF after it is a real
  // separator, so it survives this fold verbatim (round 31). Rounds 24/25 were both a look-ahead
  // outrunning this fold. The fold is quote-aware:
  // single-quoted and ANSI-C bodies keep the pair verbatim (`$'a\<LF>b'` stays one word with the
  // bytes), a comment ends at the raw newline (`# c\<LF>rm -rf /` leaves the second line a live
  // command — bash does not fold inside comments), and escape pairs are consumed whole so a `\'`
  // cannot flip the quote state and reopen the same split.
  const withoutContinuations = (source: string): string => {
    let output = '';
    let mode: 'plain' | 'single' | 'double' | 'ansi' = 'plain';
    let inComment = false;
    // Same boundary rule the `#` branch below uses, read off the folded text: after `x\<LF>#tag`
    // the `#` is mid-word, so looking at the raw source's preceding newline would lie.
    const atCommentBoundary = (): boolean => {
      if (output.length === 0) return true;
      if (!/[ \t\n;&|()<>]/.test(output[output.length - 1])) return false;
      let backslashes = 0;
      for (let cursor = output.length - 2; cursor >= 0 && output[cursor] === '\\'; cursor -= 1) backslashes += 1;
      return backslashes % 2 === 0;
    };
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (inComment) {
        if (character === '\n') inComment = false;
        output += character;
        continue;
      }
      if (mode === 'plain' && character === '#' && atCommentBoundary()) {
        inComment = true;
        output += character;
        continue;
      }
      if (character === '\\' && mode !== 'single') {
        if (mode !== 'ansi' && source[index + 1] === '\n') { index += 1; continue; }
        // Consume the pair verbatim: `\'` must not open a quote bash never opened, and the second
        // backslash of `a\\` must not pair with the newline after it (that newline is a separator).
        output += character;
        if (index + 1 < source.length) output += source[++index];
        continue;
      }
      output += character;
      if (mode === 'ansi' || mode === 'single') {
        if (character === "'") mode = 'plain';
      } else if (mode === 'double') {
        if (character === '"') mode = 'plain';
      } else if (character === '$') {
        // The fold itself changes adjacency: `$\<LF>'` is `$'` to bash (round 27). Look past the
        // continuations this pass is about to remove, or the ANSI-C opener is misread as a plain
        // single quote and every fold after it drifts. Only `\<LF>` counts — `$\<CR><LF>'` is
        // `$<CR>` then a new line to bash, not an opener (round 31 probe).
        let after = index + 1;
        while (after < source.length && source[after] === '\\') {
          if (source[after + 1] === '\n') { after += 2; continue; }
          break;
        }
        if (source[after] === "'") {
          output += source[after];
          index = after;
          mode = 'ansi';
        }
      } else if (character === "'") {
        mode = 'single';
      } else if (character === '"') {
        mode = 'double';
      }
    }
    return output;
  };
  command = withoutContinuations(command);
  // `echo foo\ #tag` — the space before `#` is escaped, so it is not a word boundary and the `#`
  // stays inside the word. Count the backslashes: an odd run escapes the character that follows.
  const isEscaped = (position: number): boolean => {
    let backslashes = 0;
    for (let cursor = position - 1; cursor >= 0 && command[cursor] === '\\'; cursor -= 1) backslashes += 1;
    return backslashes % 2 === 1;
  };
  const lines: string[] = [];
  let result = '';
  let quoteMode: 'plain' | 'single' | 'double' = 'plain';
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
    // A line continuation between the digits and the operator is removed by bash before it reads
    // the word, so `2\<LF>>&1` is the IO number 2 as well (round 24: it used to survive as cp's
    // last operand and replace the real write target).
    if (quoteMode === 'plain' && atWordStart && /[0-9]/.test(character)) {
      const ioNumber = command.slice(index).match(/^[0-9]+(?=[<>])/);
      if (ioNumber) {
        index += ioNumber[0].length - 1;
        continue;
      }
    }
    if (quoteMode === 'plain' && /\s/.test(character) && !/[ \t\n]/.test(character)) {
      // JS `\s` is wider than bash's metacharacters: U+000D, U+00A0, U+000B, U+3000… are ordinary word bytes
      // to bash but separators to shell-quote (and would make a following `#` look like a comment,
      // hiding `; ./cleanup`). A backslash does not help — shell-quote drops it and still splits — so
      // wrap the byte in single quotes: `a'\u00a0'b` is the same word `a\u00a0b` to bash.
      result += `'${character}'`;
      atWordStart = false;
      continue;
    }
    if (quoteMode === 'plain' && character === '#'
      && (index === 0 || (/[ \t\n;&|()<>]/.test(command[index - 1]) && !isEscaped(index - 1)))) {
      inComment = true;
      result += character;
      continue;
    }
    if (quoteMode === 'plain' && character === '#') {
      // shell-quote treats any # as a comment start; POSIX only does so at a
      // word boundary. Escape an in-word literal before handing it over.
      result += '\\#';
      atWordStart = false;
      continue;
    }
    if (character === '\\' && quoteMode !== 'single') {
      const escapedNext = command[index + 1];
      if (quoteMode === 'plain' && escapedNext !== undefined && /\s/.test(escapedNext) && !/[ \t\n]/.test(escapedNext)) {
        // `\<U+00A0>` is that byte to bash; shell-quote would drop the backslash and split on it, so
        // it takes the same quoting path as the unescaped form (round 22).
        result += `'${escapedNext}'`;
        index += 1;
        atWordStart = false;
        continue;
      }
      result += character;
      if (escapedNext !== undefined) result += command[++index];
      atWordStart = false;
      continue;
    }
    if (quoteMode === 'plain' && character === '\n') {
      lines.push(result);
      result = '';
      atWordStart = true;
      continue;
    }
    if (quoteMode === 'plain' && character === '&' && command[index + 1] === '>') {
      // `&>f` / `&>>f` redirect both streams to f. shell-quote emits the same `&`, `>` pair for the
      // spaced `& >` — a background `&` followed by a redirect on the *next* command — so the
      // adjacency has to be read here, on the command text (folded): drop the `&` and let the `>`
      // stand. Downstream the file is a write target either way.
      continue;
    }
    if (quoteMode === 'plain' && character === '$' && command[index + 1] === "'") {
      // shell-quote does not know ANSI-C quoting: it hands `$'ls'` back as a variable callback plus
      // a single-quoted literal, which is byte-for-byte what `"$"ls` and `'${}ls'` produce too. Decode
      // the escapes here, while the quote boundaries are still visible, and hand shell-quote an
      // ordinary single-quoted literal instead. Escapes only — folding whitespace or normalizing
      // Unicode would change the identity (`l$' 's` is the program `l s`). An unterminated or
      // malformed ANSI-C word is left as written; canonicalizeCommand() flags it on the whole command.
      let end = index + 2;
      while (end < command.length && command[end] !== "'") end += command[end] === '\\' ? 2 : 1;
      const decoded = end < command.length ? decodeAnsiCQuotedBody(command.slice(index + 2, end)) : null;
      if (decoded && !decoded.failureReason) {
        result += `'${decoded.text.replaceAll("'", "'\\''")}'`;
        index = end;
        atWordStart = false;
        continue;
      }
    }
    if (quoteMode === 'plain' && character === '$' && command[index + 1] === '"') {
      // `$"…"` is a locale-translated string; for parsing it is a plain double-quoted word.
      quoteMode = 'double';
      atWordStart = false;
      result += command[++index];
      continue;
    }
    if (character === "'" && (quoteMode === 'plain' || quoteMode === 'single')) {
      quoteMode = quoteMode === 'single' ? 'plain' : 'single';
    } else if (character === '"' && (quoteMode === 'plain' || quoteMode === 'double')) {
      quoteMode = quoteMode === 'double' ? 'plain' : 'double';
    }
    atWordStart = quoteMode === 'plain' && /[ \t\n;|&()]/.test(character)
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

type WriteTargetExtraction = { targets: ShellWriteTarget[]; failed?: string };

type OptionScanEntry =
  | { kind: 'boolean'; option: string }
  | { kind: 'value'; option: string; value: string }
  | { kind: 'operand'; word: string };

// cp/mv/tee/sed option words follow the same allowlist rules as the wrapper scan above: `--` ends
// the option region (every later word is an operand, even one starting with `-`), known value
// options take their value attached (`-tdir`, `--target-directory=dir`) or as the next word, known
// boolean letters cluster (`cp -Rv`), and a letter with an optional attached value (`sed -i.bak`)
// ends its cluster. An unknown `-` word is never guessed as a flag — its value could be the real
// write target (`cp -- a -locked.txt` writes `-locked.txt`), so the scan fails closed and the
// command falls back to an approval instead of silently losing the target.
function scanArgv(
  args: string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string>,
  optionalAttachedOptions: ReadonlySet<string>,
): { entries: OptionScanEntry[]; failed?: string } {
  const entries: OptionScanEntry[] = [];
  let optionsRegion = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsRegion && arg === '--') {
      optionsRegion = false;
      continue;
    }
    if (!optionsRegion || !arg.startsWith('-') || arg === '-') {
      entries.push({ kind: 'operand', word: arg });
      continue;
    }
    if (arg.startsWith('--')) {
      const optionName = arg.split('=', 1)[0];
      if (optionalAttachedOptions.has(optionName)) {
        entries.push({ kind: 'value', option: optionName,
          value: arg.includes('=') ? arg.slice(optionName.length + 1) : '' });
        continue;
      }
      if (valueOptions.has(optionName)) {
        if (arg.includes('=')) {
          entries.push({ kind: 'value', option: optionName, value: arg.slice(optionName.length + 1) });
          continue;
        }
        const value = args[index + 1];
        if (value === undefined) return { entries, failed: `${optionName} requires a value` };
        index += 1;
        entries.push({ kind: 'value', option: optionName, value });
        continue;
      }
      if (booleanOptions.has(optionName)) {
        entries.push({ kind: 'boolean', option: optionName });
        continue;
      }
      return { entries, failed: `${optionName} option arity is not known` };
    }
    let rest = arg.slice(1);
    let failed: string | undefined;
    while (rest.length > 0) {
      const letter = `-${rest[0]}`;
      if (booleanOptions.has(letter)) {
        entries.push({ kind: 'boolean', option: letter });
        rest = rest.slice(1);
        continue;
      }
      if (valueOptions.has(letter)) {
        if (rest.length > 1) {
          entries.push({ kind: 'value', option: letter, value: rest.slice(1) });
          rest = '';
          continue;
        }
        const value = args[index + 1];
        if (value === undefined) {
          failed = `${letter} requires a value`;
          break;
        }
        index += 1;
        entries.push({ kind: 'value', option: letter, value });
        rest = '';
        continue;
      }
      if (optionalAttachedOptions.has(letter)) {
        entries.push({ kind: 'value', option: letter, value: rest.slice(1) });
        rest = '';
        continue;
      }
      failed = `${arg} option arity is not known`;
      break;
    }
    if (failed) return { entries, failed };
  }
  return { entries };
}

const TEE_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  '-a', '--append', '-p', '--help', '--version',
]);
const TEE_OPTIONAL_ATTACHED_OPTIONS: ReadonlySet<string> = new Set(['--output-error']);

// GNU + BSD union; an option missing here fails closed rather than guessing. `-b`/`--backup`,
// `--preserve`, `--reflink` and `--context` take their value only attached, never as the next word.
const CP_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-t', '--target-directory', '-S', '--suffix', '--sparse',
]);
const CP_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  '-a', '--archive', '-c', '-d', '--no-dereference', '--dereference', '-f', '--force', '-H', '-L',
  '-i', '--interactive', '-l', '--link', '-n', '--no-clobber', '--parents', '-P', '-p', '-R', '-r',
  '--recursive', '--remove-destination', '--strip-trailing-slashes', '-s', '--symbolic-link', '-T',
  '--no-target-directory', '-u', '--update', '-v', '--verbose', '-x', '--one-file-system', '-X', '-Z',
  '--copy-contents', '--debug', '--help', '--version',
]);
const CP_OPTIONAL_ATTACHED_OPTIONS: ReadonlySet<string> = new Set([
  '-b', '--backup', '--preserve', '--no-preserve', '--reflink', '--context',
]);

const MV_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-t', '--target-directory', '-S', '--suffix']);
const MV_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  '-f', '--force', '-i', '--interactive', '-n', '--no-clobber', '-u', '--update', '-v', '--verbose',
  '-T', '--no-target-directory', '--strip-trailing-slashes', '-h', '--no-dereference', '-Z',
  '--help', '--version',
]);
const MV_OPTIONAL_ATTACHED_OPTIONS: ReadonlySet<string> = new Set(['-b', '--backup', '--context']);

const SED_SCRIPT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-e', '--expression', '-f', '--file',
]);
const SED_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  ...SED_SCRIPT_VALUE_OPTIONS, '--line-length',
]);
// `-l` takes a value on GNU but is a bare flag on BSD (line-buffered output) — an unresolvable
// arity conflict, so it stays unknown and fails closed. `-H` (BSD enhanced regex) is a flag; GNU
// rejects it outright, which can only error the command, never hide a write.
const SED_BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  '-n', '--quiet', '--silent', '-r', '-E', '--regexp-extended', '-s', '--separate', '-u',
  '--unbuffered', '-z', '--null-data', '-b', '--binary', '-c', '--copy', '-a', '-H', '--posix',
  '--sandbox', '--debug', '--follow-symlinks', '--help', '--version',
]);
// GNU `-iSUFFIX` and BSD `-i`/`-I` take the backup suffix only attached or bare; the bare form must
// not consume the next word (that word is the script on GNU: `sed -i 's/x/y/' f`).
const SED_IN_PLACE_OPTIONS: ReadonlySet<string> = new Set(['-i', '-I', '--in-place']);

function sedTargets(args: string[]): WriteTargetExtraction {
  const scan = scanArgv(args, SED_VALUE_OPTIONS, SED_BOOLEAN_OPTIONS, SED_IN_PLACE_OPTIONS);
  if (scan.failed) {
    // A truncated scan cannot prove the absence of in-place editing: `sed -H -i '' …` fails at
    // `-H` yet still rewrites the file on BSD. Only an argv with no in-place marker anywhere is
    // certainly write-free — an option sed cannot parse aborts it before any write on GNU and BSD.
    const hasInPlaceMarker = args.some((arg) => /^--in-place(?:=|$)/.test(arg)
      || (/^-[^-]/.test(arg) && /[iI]/.test(arg.slice(1))));
    return hasInPlaceMarker ? { targets: [], failed: `sed ${scan.failed}` } : { targets: [] };
  }
  const backupSuffixes = scan.entries.flatMap((entry) => entry.kind === 'value'
    && SED_IN_PLACE_OPTIONS.has(entry.option) ? [entry.value] : []);
  // Without in-place editing sed writes only stdout; nothing can hide a write.
  if (backupSuffixes.length === 0) return { targets: [] };
  const backupSuffix = backupSuffixes.at(-1) ?? '';

  let scriptSeen = scan.entries.some((entry) => entry.kind === 'value'
    && SED_SCRIPT_VALUE_OPTIONS.has(entry.option));
  const files: string[] = [];
  for (const entry of scan.entries) {
    if (entry.kind !== 'operand') continue;
    // An empty word can never be opened ('' fails with ENOENT on every sed); in the BSD idiom
    // `sed -i '' -eSCRIPT f` it is the -i suffix, not a file.
    if (!entry.word) continue;
    if (!scriptSeen) {
      scriptSeen = true;
      continue;
    }
    files.push(entry.word);
  }
  // `sed -i.bak f` also creates `f.bak`; a deny on the suffix pattern (*.pem) has to see it.
  return {
    targets: files.flatMap((target) => {
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
    }),
  };
}

function teeTargets(args: string[]): WriteTargetExtraction {
  const scan = scanArgv(args, new Set(), TEE_BOOLEAN_OPTIONS, TEE_OPTIONAL_ATTACHED_OPTIONS);
  if (scan.failed) return { targets: [], failed: `tee ${scan.failed}` };
  return {
    targets: scan.entries.flatMap((entry) => entry.kind === 'operand' ? [{
      path: entry.word,
      source: 'tee' as const,
      uncertain: /[$`*?{}]/.test(entry.word),
    }] : []),
  };
}

function copyMoveTargets(program: 'cp' | 'mv', args: string[]): WriteTargetExtraction {
  const scan = scanArgv(
    args,
    program === 'cp' ? CP_VALUE_OPTIONS : MV_VALUE_OPTIONS,
    program === 'cp' ? CP_BOOLEAN_OPTIONS : MV_BOOLEAN_OPTIONS,
    program === 'cp' ? CP_OPTIONAL_ATTACHED_OPTIONS : MV_OPTIONAL_ATTACHED_OPTIONS,
  );
  if (scan.failed) return { targets: [], failed: `${program} ${scan.failed}` };
  let directory: string | undefined;
  const operands: string[] = [];
  for (const entry of scan.entries) {
    if (entry.kind === 'operand') operands.push(entry.word);
    else if (entry.kind === 'value' && (entry.option === '-t' || entry.option === '--target-directory')) {
      directory = entry.value;
    }
  }
  const target = directory ?? operands.at(-1);
  return {
    targets: target === undefined ? [] : [{
      path: target,
      source: program === 'cp' ? 'copy' : 'move',
      uncertain: /[$`*?{}]/.test(target),
    }],
  };
}

function commandWriteTargets(execution: ShellExecution): WriteTargetExtraction {
  const program = basename(execution.program);
  if (program === 'sed') return sedTargets(execution.args);
  if (program === 'tee') return teeTargets(execution.args);
  if (program === 'cp' || program === 'mv') return copyMoveTargets(program, execution.args);
  return { targets: [] };
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
  let segmentRedirects: ShellWriteTarget[] = [];
  let segmentReads: ParsedShellSegment['reads'] = [];
  let trailingOperator = false;
  let failed = canonical.parsingFailed;
  let failureReason = canonical.failureReason;

  const flush = (terminator: SegmentTerminator): void => {
    if (words.length > 0) segments.push({ words, redirects: segmentRedirects, reads: segmentReads, terminator });
    words = [];
    segmentRedirects = [];
    segmentReads = [];
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (isOperator(entry) && entry.op === 'glob' && 'pattern' in entry) {
      words.push(String((entry as ShellGlob).pattern));
      continue;
    }
    if (isOperator(entry) && INPUT_REDIRECTS.has(entry.op)) {
      // Input plumbing is not a write, but dropping it as "unsupported" erased the whole segment and
      // blinded the credential rules (`rm -rf ~/.ssh/id_rsa < README.md` decayed from deny to ask).
      // `<<EOF` arrives from shell-quote as two `<` operators plus the delimiter. The body that
      // follows is its command's stdin, not commands, yet this parser cannot see where the body
      // ends — so the strict parse fails (round 33) and the risk scans fall back to
      // lenientCommandWords(), which keeps every word including the delimiter.
      const next = entries[index + 1];
      const heredoc = entry.op === '<' && isOperator(next) && next.op === '<';
      const operand = entryWord(entries[index + (heredoc ? 2 : 1)]);
      if (!operand) {
        failed = true;
        failureReason ??= `missing redirection operand after ${entry.op}`;
        continue;
      }
      if (heredoc) {
        failed = true;
        failureReason ??= 'here-document body is not separable from commands';
      }
      index += heredoc ? 2 : 1;
      if (entry.op === '<' && !heredoc) segmentReads.push({ path: operand.word, uncertain: operand.uncertain });
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
      const redirect: ShellWriteTarget = { path: target.word, source: 'redirect', uncertain: target.uncertain };
      redirects.push(redirect);
      segmentRedirects.push(redirect);
      continue;
    }
    if (isOperator(entry) && COMMAND_SEPARATORS.has(entry.op)) {
      flush(entry.op as SegmentTerminator);
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
  flush(null);
  return { segments, redirects, failed, failureReason, trailingOperator };
}

type Expansion = {
  executions: ShellExecution[];
  targets: ShellWriteTarget[];
  uncertain: string[];
  failed?: string;
  /** Set when the segment is nothing but assignments: it has no command, but it changes the shell. */
  assignments?: string[];
};

function expandExecutions(
  wordsInput: string[],
  originalProgram: string,
  wrappers: string[],
  depth: number,
): Expansion {
  const words = wordsInput;
  if (words.length === 0) return { executions: [], targets: [], uncertain: [] };
  if (depth > MAX_WRAPPER_DEPTH) {
    return { executions: [], targets: [], uncertain: [], failed: 'shell wrapper depth exceeds 4' };
  }

  // `MODE=1 tee src/x.ts` — a segment may start with env assignments. Reading the first word as the
  // program makes `MODE=1` the program and tee's write target never reaches the path deny check.
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start += 1;
  if (start >= words.length) return { executions: [], targets: [], uncertain: [], assignments: words };
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
          originalProgram, wrappers: [...wrappers, program] }],
        targets: [],
        uncertain: ['shell-script-operand'],
      };
    }
    return expandCommand(script.command, originalProgram, [...wrappers, program], depth + 1);
  }
  if (programName === 'eval') {
    return args.length === 0
      ? { executions: [{ program, args, originalProgram, wrappers }], targets: [], uncertain: [] }
      : expandCommand(args.join(' '), originalProgram, [...wrappers, program], depth + 1);
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
    const expanded = expandExecutions(nested, originalProgram, [...wrappers, program], depth + 1);
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
    const scan = commandWriteTargets(execution);
    const failed = scan.failed ?? nested.failed;
    return {
      executions: [execution, ...nested.executions],
      targets: [...scan.targets, ...nested.targets],
      uncertain: [...launcherUncertain, ...nested.uncertain],
      ...(failed ? { failed } : {}),
    };
  }
  const scan = commandWriteTargets(execution);
  return {
    executions: [execution],
    targets: scan.targets,
    uncertain: launcherUncertain,
    ...(scan.failed ? { failed: scan.failed } : {}),
  };
}

// `PATH=./bin; ls` — a segment made only of assignments has no command of its own, yet it changes
// how every later segment of the same shell resolves executables. Carry it onto them so the
// automatic-approval shortcut sees the same environment change as the `PATH=./bin ls` spelling.
function expandSegments(
  segments: ParsedShellSegment[],
  originalProgram: string | null,
  wrappers: string[],
  depth: number,
): Expansion[] {
  const carried: string[] = [];
  return segments.map((segment) => {
    const expanded = expandExecutions(
      segment.words, originalProgram ?? segment.words[0] ?? '', wrappers, depth);
    if (expanded.assignments) {
      carried.push(...expanded.assignments);
      return expanded;
    }
    if (carried.length > 0) {
      for (const execution of expanded.executions) {
        execution.environmentAssignments = [...carried, ...(execution.environmentAssignments ?? [])];
      }
    }
    return expanded;
  });
}

function expandCommand(
  command: string,
  originalProgram: string,
  wrappers: string[],
  depth: number,
): Expansion {
  const parsed = parseEntries(command);
  if (parsed.failed) {
    return { executions: [], targets: parsed.redirects, uncertain: [], failed: parsed.failureReason };
  }
  const expanded = expandSegments(parsed.segments, originalProgram, wrappers, depth);
  return {
    executions: expanded.flatMap((item) => item.executions),
    targets: [...parsed.redirects, ...expanded.flatMap((item) => item.targets)],
    uncertain: expanded.flatMap((item) => item.uncertain),
    failed: expanded.find((item) => item.failed)?.failed,
  };
}

export function parseShellCommand(command: string): ParsedShellCommand {
  const parsed = parseEntries(command);
  const expanded = expandSegments(parsed.segments, null, [], 0);
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

/**
 * Every token shell-quote can still see, structure ignored (operators included, as the baseline's
 * textual tokenizer kept them). Deny/ask rules read this when the strict parse fails: a command we
 * cannot structure must widen their view, never empty it — `rm -rf ~/.ssh/id_rsa >| run.log` keeps
 * its credential path. Never an input to an approval proof; those stay on commandWordsFromParse().
 */
export function lenientCommandWords(command: string): string[] {
  try {
    return shellLines(command)
      .flatMap((line) => parse(line, (key) => `\${${key}}`) as ShellEntry[])
      .flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (!isOperator(entry)) return [];
        return [entry.op === 'glob' && 'pattern' in entry ? String((entry as ShellGlob).pattern) : entry.op];
      });
  } catch {
    return canonicalizeCommand(command).command.split(/\s+/).filter(Boolean);
  }
}

export function commandWordsFromParse(command: string): string[] | null {
  const parsed = parseShellCommand(command);
  return parsed.parsingFailed || parsed.segments.length !== 1 || parsed.trailingOperator
    ? null
    : parsed.segments[0].words;
}

function qualifySegments(command: string): ShellExecution[] | null {
  const parsed = parseShellCommand(command);
  if (parsed.parsingFailed || parsed.trailingOperator || parsed.uncertain.length > 0) return null;

  const executions: ShellExecution[] = [];
  for (const segment of parsed.segments) {
    const [program, ...args] = segment.words;
    if (!program) continue;

    // This is the only qualification-time unwrapping.  Do not use basename:
    // ./bash and /usr/bin/bash are executable identities chosen by the caller.
    if (QUALIFICATION_SHELLS.has(program) && (args[0] === '-c' || args[0] === '-lc')) {
      const script = args[1];
      if (script === undefined) return null;
      const nested = qualifySegments(script);
      if (!nested) return null;
      executions.push(...nested);
      continue;
    }

    executions.push({ program, args, originalProgram: program, wrappers: [] });
  }
  return executions;
}

/**
 * Executions used for automatic-approval qualification.
 *
 * Unlike parseShellCommand().executions, this preserves the command identity
 * as written and only applies the baseline's narrow bash/sh/zsh -c/-lc unwrap.
 * Consumers deciding whether a command may skip approval must use this view;
 * write-target consumers must continue using parseShellCommand().executions.
 */
/**
 * The operator closing the AND/OR list the segment at `index` belongs to. `&` backgrounds the
 * entire list — a `cd` inside `cd /tmp && env & …` runs in the subshell and must not move the
 * parent shell's cwd. `|&` is a pipe (`2>&1 |`), not a background operator: a chain closed by
 * `|&` or `|` pipelines only the last pipeline, so the cd in `a && b |& c` still runs in the
 * parent.
 */
export function listTerminatorAfter(terminators: SegmentTerminator[], index: number): SegmentTerminator {
  let chainEnd = index;
  while (terminators[chainEnd] === '&&' || terminators[chainEnd] === '||') chainEnd += 1;
  return terminators[chainEnd] ?? null;
}

export function qualificationExecutions(command: string): ShellExecution[] | null {
  return qualifySegments(command);
}

export function qualificationExecutable(command: string): ShellExecution | null {
  const executions = qualificationExecutions(command);
  return executions?.length !== 1
    ? null
    : executions[0];
}
