const SANDBOX_DENIAL_PATTERN = /\bEPERM\b|Operation not permitted/i;

/**
 * Path from a sandbox write denial. npm also prints `error path <file>` for
 * ENOENT and other codes; those lines are not a denied write unless the
 * failure text itself is EPERM / Operation not permitted.
 */
export function sandboxDeniedWritePath(failureText: string): string | undefined {
  if (!SANDBOX_DENIAL_PATTERN.test(failureText)) return undefined;
  return readSandboxDeniedWritePath(failureText);
}

/**
 * Python raises the same `PermissionError: [Errno 1] Operation not permitted:
 * '<path>'` for reads and writes alike (open, os.stat, os.listdir …), so the
 * error line alone cannot prove a denied write. The traceback frames above it
 * must name a write call; otherwise a seatbelt read denial (os.stat on
 * ~/.npmrc …) would open the widen card and re-run with a write grant the
 * still-denied read cannot use (PR #2420 review).
 */
const PYTHON_PERMISSION_ERROR_PATTERN = /\bPermissionError:\s*\[Errno\s+1\]\s+Operation not permitted:\s*['"]([^'"\r\n]+)['"]/gi;
const PYTHON_WRITE_CALL_PATTERN = new RegExp(
  [
    // open(p, 'w'/'wb'/'a'/'x'/'r+'…) / ZipFile(p, 'w'): the mode literal must
    // contain w/a/x/+; a bare 'r'/'rb' mode or no mode at all is a read.
    String.raw`\b(?:open|ZipFile)\s*\([^()\r\n]*(?:,\s*|\bmode\s*=\s*)['"][rwaxbt+]*[wax+][rwaxbt+]*['"]`,
    // calls that write by name alone (os.* and pathlib/zipfile methods share them)
    String.raw`\b(?:makedirs|mkdir|rmdir|remove|unlink|rename|replace|truncate|chmod|lchmod|chown|symlink|link|utime|touch|write|writelines|writestr|write_text|write_bytes|symlink_to|hardlink_to)\s*\(`,
  ].join('|'),
  'i',
);

function pythonDeniedWritePath(failureText: string): { path: string; innermostCall: string } | undefined {
  for (const match of failureText.matchAll(PYTHON_PERMISSION_ERROR_PATTERN)) {
    const frames = pythonTracebackSourceLines(failureText, match.index);
    if (frames?.some((line) => PYTHON_WRITE_CALL_PATTERN.test(line))) {
      return { path: match[1] as string, innermostCall: frames[0] ?? '' };
    }
  }
  return undefined;
}

/**
 * Source lines of the traceback block ending at `errorIndex`, innermost frame
 * first, or undefined when the exception is not preceded by a traceback (a bare
 * re-quoted error line proves nothing either way). Frame headers
 * (`File "…", line N`), the `~~~^^^` anchors under them and blank separators
 * are skipped; the `Traceback` header ends the block, and an earlier exception
 * line or chain separator (`During handling …`) invalidates it, so frames of a
 * previous exception cannot vouch for this one.
 */
function pythonTracebackSourceLines(text: string, errorIndex: number): string[] | undefined {
  const lines = text.slice(0, errorIndex).split(/\r?\n/);
  const source: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    if (/^[\s~^!_.]+$/.test(line)) continue; // `~~~^^^` anchors / `____` separators
    if (/^\s*File\s+"/.test(line)) continue; // frame header (source may follow)
    if (/^\s*Traceback\b/.test(line)) return source; // block start reached
    // A previous exception's message or a chained-exception separator: frames
    // above it belong to that exception, not this one.
    if (/^\s*(?:[A-Za-z_][\w.]*\s*:|During handling|The above exception)/.test(line)) return undefined;
    source.push(line);
  }
  return undefined; // ran off the top without a Traceback header
}

/**
 * Only shapes that prove a *write* was denied may open the widen-sandbox card.
 * The generic `<cmd>: <path>: Operation not permitted` form also comes from
 * macOS TCC / deniedReadRoots read denials (`find: ~/Library/Mail: …`); offering
 * a write grant there lies about the cause and re-runs the whole command for
 * nothing (PR #2191 review). That form stays diagnostics-only.
 */
const NODE_WRITE_ERROR_PATTERN = /\bEPERM\b[^\r\n]*?\b(open|mkdir|rmdir|unlink|rename|chmod|chown|copyfile|symlink|link|truncate|utimes)\s+['"]([^'"\r\n]+)['"]/gi;

/**
 * Node raises the SAME `Error: EPERM: operation not permitted, open '<path>'`
 * for a seatbelt read denial and a write denial; only the stack frames under
 * the error line tell them apart (`at Object.readFileSync` vs
 * `at Object.writeFileSync`) — the same ambiguity PR #2420 resolved for Python
 * tracebacks. Frames naming a read API with no write API among them prove the
 * denied call was a read, and a write grant the still-denied read cannot use
 * must not be offered (it would point the user at a credential file).
 */
const NODE_READ_FRAME_PATTERN = /\b(?:readFile\w*|createReadStream|ReadStream|readdir\w*|opendir\w*)\b/;
const NODE_WRITE_FRAME_PATTERN = /\b(?:writeFile\w*|appendFile\w*|createWriteStream|WriteStream)\b/;

/**
 * Stack lines directly under a Node error line: `    at …` frames (sync and
 * `at async …`), plus the `Emitted 'error' event on <Stream> instance at:`
 * header an unhandled stream error prints instead — that header names the
 * stream class (ReadStream / WriteStream), so it counts as a frame. Anything
 * else (the `errno` property block, a blank line, a re-quoted message) ends
 * the block; no frames below the error line proves nothing either way.
 */
function nodeErrorFramesBelow(text: string, errorIndex: number): string[] | undefined {
  const lines = text.slice(errorIndex).split(/\r?\n/);
  const frames: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\s*(?:at\s|Emitted\s)/.test(line)) break;
    frames.push(line);
  }
  return frames.length > 0 ? frames : undefined;
}

function nodeOpenDeniedByRead(text: string, errorIndex: number): boolean {
  const frames = nodeErrorFramesBelow(text, errorIndex);
  if (!frames) return false;
  return frames.some((line) => NODE_READ_FRAME_PATTERN.test(line))
    && !frames.some((line) => NODE_WRITE_FRAME_PATTERN.test(line));
}

function readSandboxDeniedWritePath(failureText: string): string | undefined {
  for (const match of failureText.matchAll(NODE_WRITE_ERROR_PATTERN)) {
    // The `open` shape alone is ambiguous between a read and a write denial;
    // only proven-read frames (read API and no write API) skip the match. No
    // frames or ambiguous frames (`at Object.openSync`) keep today's result.
    if (match[1] === 'open' && match.index !== undefined && nodeOpenDeniedByRead(failureText, match.index)) continue;
    // `copyfile '<src>' -> '<dst>'` prints the FIRST quoted operand as the
    // source, which is also `req->path` for BOTH errors (libuv uv__fs_copyfile),
    // so a read-denied source and a write-denied destination are byte-identical
    // apart from the paths. A write grant can only ever target the destination,
    // and a grant on the source would ask the user to allow writing a file it
    // merely fails to read; the destination is therefore the only operand we
    // return. Residual (accepted): a read-denied source still yields a card
    // whose retry cannot succeed — misleading, but never a grant on the source.
    if (match[1] === 'copyfile') {
      const rest = match.index !== undefined ? failureText.slice(match.index + match[0].length) : '';
      const dest = /^\s*->\s*['"]([^'"\r\n]+)['"]/.exec(rest)?.[1];
      if (!dest) continue;
      return dest;
    }
    return match[2];
  }

  const pythonWrite = pythonDeniedWritePath(failureText);
  if (pythonWrite) return pythonWrite.path;

  const npmErrorPath = /(?:^|\n)(?:npm (?:error|ERR!)\s+)?path\s+([^\r\n]+)/im.exec(failureText)?.[1]?.trim();
  if (npmErrorPath) return npmErrorPath;

  // shell redirection: `/bin/sh: /path: Operation not permitted`, `bash: line 1: /path: …`, `zsh: operation not permitted: /path`
  const shellRedirect = /(?:^|\n)(?:\/\S*\/)?(?:bash|sh|zsh|dash)(?:-?[\d.]*)?(?::\s+line\s+\d+)?:\s+((?:~|\/)[^:\r\n]+):\s+Operation not permitted\b/im.exec(failureText)?.[1]?.trim()
    ?? /(?:^|\n)zsh:\s+operation not permitted:\s+((?:~|\/)[^\r\n]+)/im.exec(failureText)?.[1]?.trim();
  if (shellRedirect) return shellRedirect;

  // write utilities: `mkdir: /path: Operation not permitted`, `cp: /path: …`
  const writeUtilityPath = /(?:^|\n)(?:mkdir|touch|cp|mv|rm|rmdir|tee|install|ln|chmod|chown|truncate)(?:\s+\S+)?:\s+((?:~|\/)[^:\r\n]+):\s+Operation not permitted\b/im.exec(failureText)?.[1]?.trim();
  if (writeUtilityPath) return writeUtilityPath;

  // chmod's real shapes put prose after the first colon, so the write-utilities
  // form above misses them: macOS/BSD `chmod: Unable to change file mode on
  // <path>: Operation not permitted` (the path may contain spaces) and GNU
  // `chmod: changing permissions of '<path>': Operation not permitted` — on
  // macOS GNU coreutils installs as `gchmod` and prefixes the line with it.
  return /(?:^|\n)chmod:\s+Unable to change file mode on\s+((?:~|\/).+?):\s+Operation not permitted\b/im.exec(failureText)?.[1]?.trim()
    ?? /(?:^|\n)g?chmod:\s+changing permissions of\s+'((?:~|\/)[^'\r\n]+)':\s+Operation not permitted\b/im.exec(failureText)?.[1]?.trim();
}

/**
 * True when the denied write was creating a directory (node `mkdir` EPERM,
 * shell `mkdir: <path>: Operation not permitted`, or a Python traceback whose
 * innermost frame names `mkdir`/`makedirs`). A seatbelt subpath grant on a
 * directory that does not exist yet lets the retry create it and write any name
 * inside, so policy must treat the missing path as a directory (PR #2191 review).
 */
export function sandboxDeniedWriteCreatesDirectory(failureText: string): boolean {
  if (!SANDBOX_DENIAL_PATTERN.test(failureText)) return false;
  if (/\bEPERM\b[^\r\n]*?\bmkdir\s+['"]/i.test(failureText)) return true;
  if (/(?:^|\n)mkdir:\s+(?:~|\/)[^:\r\n]+:\s+Operation not permitted\b/im.test(failureText)) return true;
  const pythonWrite = pythonDeniedWritePath(failureText);
  return pythonWrite !== undefined && /\b(?:makedirs|mkdir)\s*\(/.test(pythonWrite.innermostCall);
}

function readSandboxDeniedPath(failureText: string): string | undefined {
  const nodeErrorPath = /\bEPERM\b[^\r\n]*?\b(?:open|mkdir|unlink|rename|scandir|stat|lstat|access|chmod|chown)\s+['"]([^'"\r\n]+)['"]/i.exec(failureText)?.[1];
  if (nodeErrorPath) return nodeErrorPath;

  const npmErrorPath = /(?:^|\n)(?:npm (?:error|ERR!)\s+)?path\s+([^\r\n]+)/im.exec(failureText)?.[1]?.trim();
  if (npmErrorPath) return npmErrorPath;

  return /(?:^|\n)[^:\r\n]+:\s+((?:~|\/)[^:\r\n]+):\s+Operation not permitted\b/im.exec(failureText)?.[1]?.trim();
}

export function diagnoseSandboxDenial(input: {
  failureText: string;
  sandboxed?: boolean;
  workingDirectory?: string;
}): string | undefined {
  if (!input.sandboxed || !SANDBOX_DENIAL_PATTERN.test(input.failureText)) return undefined;

  const deniedPath = readSandboxDeniedPath(input.failureText);
  return deniedPath
    ? `沙盒拒绝：${deniedPath}（沙盒只允许写 ${input.workingDirectory ?? '工作目录'} 与临时目录）`
    : '沙盒拒绝了工作目录外的写入';
}

export interface BashFailureDiagnosticsInput {
  command: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  code?: number | string | null;
  durationMs?: number;
  sandboxed?: boolean;
  workingDirectory?: string;
}

const SELF_KILL_SIGNALS = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL']);
const KILL_COMMAND_PATTERN = /\b(?:pkill|killall|kill)\b/;
const NODE_TOOL_PATTERN = /\b(npx|node|npm)\b/;
const MISSING_COMMAND_PATTERN = /\bENOENT\b|command not found|not found/i;

export function diagnoseBashFailure(input: BashFailureDiagnosticsInput): string[] {
  const diagnostics: string[] = [];
  const signal = input.signal ?? undefined;
  const durationMs = input.durationMs ?? Number.POSITIVE_INFINITY;

  if (
    signal
    && SELF_KILL_SIGNALS.has(signal)
    && durationMs < 1000
    && KILL_COMMAND_PATTERN.test(input.command)
  ) {
    diagnostics.push(
      '诊断：命令可能用 kill/pkill/killall 终止了当前 shell 进程；如果目标是清理其他进程，请避免匹配当前 bash，或改用更精确的 PID。',
    );
  }

  const nodeTool = input.command.match(NODE_TOOL_PATTERN)?.[1];
  const failureText = [input.message, input.stdout, input.stderr].filter(Boolean).join('\n');

  const sandboxDenial = diagnoseSandboxDenial({
    failureText,
    sandboxed: input.sandboxed,
    workingDirectory: input.workingDirectory,
  });
  if (sandboxDenial) diagnostics.push(sandboxDenial);

  if (nodeTool && MISSING_COMMAND_PATTERN.test(failureText)) {
    diagnostics.push(
      `诊断：${nodeTool} 启动失败，可能是 Node.js 依赖或可执行文件缺失（ENOENT / command not found）。建议先确认依赖已安装，并检查 PATH / node_modules。`,
    );
  }

  if (String(input.code) === '137') {
    diagnostics.push(
      '诊断：exit 137 通常表示进程可能被系统 OOM killer 终止（内存不足）。建议降低并发、减少构建规模，或改用后台任务观察输出。',
    );
  }

  return diagnostics;
}

export function appendFailureDiagnostics(message: string, diagnostics: string[]): string {
  if (diagnostics.length === 0) return message;
  return `${message}\n\n${diagnostics.join('\n')}`;
}
