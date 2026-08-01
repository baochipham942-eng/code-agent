// ============================================================================
// terminal_* —— Agent 读写用户那个交互终端的桥（Term-P1）
//
// 这里操作的 PTY 与右栏终端视图是**同一个**：用户在里面 `grok login` 之后，Agent
// 接着用的就是那个登录态。因此三条硬约束贯穿本文件：
//   1. 写入过审批链 + 与 bash 同一个 validateCommand 命令安全检查；
//   2. 写入对用户可见——注入前先把「Neo 敲了什么」印进终端画面，不能凭空冒出结果；
//   3. 读回的输出禁止把原始 ANSI 全量塞进模型上下文（strip + 尾部 N 行）。
// ============================================================================

import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import {
  terminalListSchema,
  terminalReadSchema,
  terminalWaitSchema,
  terminalWriteSchema,
} from './terminal.schema';
import {
  annotateTerminalSession,
  getTerminalSnapshot,
  listTerminalSessions,
  writeToTerminalSession,
} from '../../../services/terminal/terminalSessionManager';
import { validateCommand } from '../../../security';

const DEFAULT_TAIL_LINES = 100;
const MAX_TAIL_LINES = 500;
const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 120_000;
const DEFAULT_QUIET_MS = 800;
const WAIT_POLL_MS = 200;

// ----------------------------------------------------------------------------
// 输出清洗
// ----------------------------------------------------------------------------

/**
 * 原始 PTY 输出 → 可以进模型上下文的纯文本。
 *
 * 不能只做正则替换。真 shell 的流长这样（zsh 实录）：
 *   `%<79个空格>\r \r\r<SGR>prompt % \x1b[K\x1b[?2004he\becho hi\x1b[?2004l\r\r\nhi\r\n`
 * `\r` 在这里是**光标回到行首**，后面的字符逐个覆盖上去；`\b` 是退一格。
 * 早先按「取最后一个 \r 之后的内容」处理，等于把整行真内容全丢掉——实测一段带两条命令
 * 和输出的会话被清洗成 4 个空行，模型看到的是一个空终端。所以这里按真实光标语义重放：
 * 维护一行缓冲 + 列号，`\r` 归零、`\b` 退一格、`\x1b[K` 擦到行尾，其余字符写在光标处。
 *
 * ponytail: 只实现单行内的光标语义 + 擦行，不做光标定位（\x1b[H / \x1b[nA）。
 * 全屏 TUI（vim/top）本来就不该指望读成通顺文本；要那个得上真 emulator，不是这里的活。
 */
export function stripTerminalControlCodes(raw: string): string {
  const lines: string[] = [];
  let line = '';
  let col = 0;

  const put = (ch: string): void => {
    if (col === line.length) line += ch;
    else line = line.slice(0, col) + ch + line.slice(col + 1);
    col += 1;
  };
  const endLine = (): void => {
    lines.push(line);
    line = '';
    col = 0;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (ch === '\x1b') {
      const next = raw[i + 1];
      if (next === '[') {
        // CSI: ESC [ params intermediates final
        let j = i + 2;
        while (j < raw.length && /[0-9;?]/.test(raw[j])) j += 1;
        const params = raw.slice(i + 2, j);
        while (j < raw.length && /[ -/]/.test(raw[j])) j += 1;
        const final = raw[j];
        if (final === 'K') {
          // erase in line: 0/缺省=光标到行尾，1=行首到光标，2=整行
          if (params === '' || params === '0') line = line.slice(0, col);
          else if (params === '1') line = ' '.repeat(col) + line.slice(col);
          else if (params === '2') line = '';
        }
        i = j < raw.length ? j : raw.length;
        continue;
      }
      if (next === ']') {
        // OSC: 到 BEL 或 ESC \ 为止
        let j = i + 2;
        while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j += 1;
        i = raw[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      i += 1; // 其余两字符转义，整个丢掉
      continue;
    }

    if (ch === '\n') { endLine(); continue; }
    if (ch === '\r') { col = 0; continue; }
    if (ch === '\b') { col = Math.max(0, col - 1); continue; }
    if (ch === '\x07') continue; // 响铃不是内容
    put(ch);
  }
  if (line.length > 0) lines.push(line);

  // 覆盖会在行尾留下一串被顶出来的空格（prompt 重画的填充），逐行 trimEnd 掉
  return lines.map((entry) => entry.replace(/\s+$/, '')).join('\n');
}

export function tailLines(text: string, count: number): string {
  const lines = text.split('\n');
  return lines.length <= count ? text : lines.slice(-count).join('\n');
}

export function readTerminalTail(raw: string, count: number): string {
  return tailLines(stripTerminalControlCodes(raw), count).trimEnd();
}

// ----------------------------------------------------------------------------
// 密码 prompt 拒填（调研反面教材第二条）
// ----------------------------------------------------------------------------

const SECRET_PROMPT_PATTERNS: readonly RegExp[] = [
  // 冒号前允许夹任意非冒号文本，一次覆盖 "Password:" / "[sudo] password for x:" /
  // "Enter passphrase for key '/Users/x/.ssh/id_ed25519':" —— 别按具体措辞逐条枚举，
  // 那是按名字列拒绝清单，新措辞一出现就静默放行。
  /pass(?:word|phrase)\b[^:：]*[:：]\s*$/i,
  /enter\s+(?:your\s+)?(?:pin|passcode|secret|token|api\s*key)\b[^:：]*[:：]\s*$/i,
  /(?:one[- ]time|verification|authentication|2fa|otp|mfa)\s*code\b[^:：]*[:：]\s*$/i,
  /密码\s*[:：]\s*$/,
  /口令\s*[:：]\s*$/,
  /验证码\s*[:：]\s*$/,
];

/**
 * 终端此刻是不是正停在一个要人输入秘密的 prompt 上。
 *
 * 判据取**最后一段非空输出**：这类 prompt 不换行，光标就停在冒号后面。往前多看几行
 * 会把历史里出现过的 "password:" 也算进来，反而把正常写入全堵死。
 */
export function isAwaitingSecretInput(rawOutput: string): boolean {
  const cleaned = stripTerminalControlCodes(rawOutput);
  const lastLine = cleaned.split('\n').filter((line) => line.trim().length > 0).pop();
  if (!lastLine) return false;
  return SECRET_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine.trimEnd()));
}

const SECRET_TAKEOVER_MESSAGE =
  'The terminal is waiting for a password / passphrase / verification code. '
  + 'You must not type it. Tell the user to enter it themselves in the terminal panel on the right, '
  + 'then continue once they say they are done.';

// ----------------------------------------------------------------------------
// 共用
// ----------------------------------------------------------------------------

function resolveSessionId(args: Record<string, unknown>, ctx: ToolContext): string {
  const explicit = args.session_id;
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : ctx.sessionId;
}

function clamp(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : fallback;
}

const NO_SESSION_HINT =
  'No terminal is open for this conversation. Ask the user to open the Terminal view in the right rail first '
  + '(they may also need to log in to the CLI you want to drive).';

// ----------------------------------------------------------------------------
// terminal_list
// ----------------------------------------------------------------------------

class TerminalListHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = terminalListSchema;

  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
    const sessions = listTerminalSessions();
    if (sessions.length === 0) {
      return { ok: true, output: NO_SESSION_HINT, meta: { count: 0 } };
    }
    const lines = sessions.map((session) => {
      const current = session.sessionId === ctx.sessionId ? ' (this conversation)' : '';
      const state = session.alive ? 'alive' : 'exited';
      return `- ${session.sessionId}${current}: ${state}, shell=${session.shell}, cwd=${session.cwd}`;
    });
    return { ok: true, output: lines.join('\n'), meta: { count: sessions.length } };
  }
}

// ----------------------------------------------------------------------------
// terminal_read
// ----------------------------------------------------------------------------

class TerminalReadHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = terminalReadSchema;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
    const sessionId = resolveSessionId(args, ctx);
    const snapshot = getTerminalSnapshot(sessionId);
    if (!snapshot) return { ok: false, error: NO_SESSION_HINT, code: 'NOT_FOUND' };

    const count = clamp(args.tail_lines, DEFAULT_TAIL_LINES, MAX_TAIL_LINES);
    const output = readTerminalTail(snapshot.data, count);
    return {
      ok: true,
      output: output.length > 0 ? output : '(terminal has produced no output yet)',
      meta: { sessionId, alive: snapshot.alive, tailLines: count },
    };
  }
}

// ----------------------------------------------------------------------------
// terminal_write
// ----------------------------------------------------------------------------

class TerminalWriteHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = terminalWriteSchema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const input = args.input;
    if (typeof input !== 'string' || input.length === 0) {
      return { ok: false, error: 'input is required', code: 'INVALID_ARGS' };
    }

    const sessionId = resolveSessionId(args, ctx);
    const snapshot = getTerminalSnapshot(sessionId);
    if (!snapshot) return { ok: false, error: NO_SESSION_HINT, code: 'NOT_FOUND' };
    if (!snapshot.alive) {
      return { ok: false, error: `The terminal for ${sessionId} has exited.`, code: 'TERMINAL_EXITED' };
    }

    // 1) 秘密 prompt 拒填——在任何审批之前，因为这条不是「要不要批准」，是根本不该问。
    if (isAwaitingSecretInput(snapshot.data)) {
      ctx.logger.warn('terminal_write refused: secret prompt', { sessionId });
      return { ok: false, error: SECRET_TAKEOVER_MESSAGE, code: 'NEEDS_USER_TAKEOVER' };
    }

    // 2) 与 bash 同一份命令安全检查：critical 直接毙，不进审批。
    const validation = validateCommand(input);
    if (!validation.allowed) {
      ctx.logger.warn('terminal_write blocked by command safety', { sessionId, reason: validation.reason });
      return {
        ok: false,
        error: `Security: Command blocked - ${validation.reason ?? 'unsafe command'}`,
        code: 'COMMAND_BLOCKED',
      };
    }

    // 3) 审批链。高危命令带 dangerous: 前缀，走 UI 的二次确认流。
    const permit = await canUseTool(
      terminalWriteSchema.name,
      args,
      validation.riskLevel === 'high'
        ? `dangerous:typing into the user's live terminal: ${input.slice(0, 200)}`
        : `typing into the user's live terminal: ${input.slice(0, 200)}`,
    );
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

    onProgress?.({ stage: 'starting', detail: input.slice(0, 80) });

    // 4) 秘密 prompt 复检。审批是异步的，用户可能想了半分钟才点同意——这期间终端里正在跑的
    //    东西完全可能已经走到密码提示上（`sudo apt install` 跑着跑着弹 [sudo] password:）。
    //    只在审批前查一次是 TOCTOU：真正决定写进哪儿的是**此刻**的终端状态。
    const beforeWrite = getTerminalSnapshot(sessionId);
    if (!beforeWrite?.alive) {
      return { ok: false, error: `The terminal for ${sessionId} has exited.`, code: 'TERMINAL_EXITED' };
    }
    if (isAwaitingSecretInput(beforeWrite.data)) {
      ctx.logger.warn('terminal_write refused: secret prompt appeared while awaiting approval', { sessionId });
      return { ok: false, error: SECRET_TAKEOVER_MESSAGE, code: 'NEEDS_USER_TAKEOVER' };
    }

    // 5) 注入对用户可见：先在终端里印出来是谁敲的，再真敲。顺序不能反——先写后回显的话，
    //    命令输出会跑在标注前面，用户看到的就是「结果先于来源」。
    const pressEnter = args.pressEnter !== false;
    annotateTerminalSession(sessionId, `\r\n\x1b[36m[Neo] ${input}\x1b[0m\r\n`);

    // 提交键必须是 CR(\r) 而不是 LF(\n)。全屏 TUI（Codex CLI / vim / less…）把终端设成 raw
    // 模式直接读按键字节，Enter 就是 13；发 10 它当普通字符收下，文字停在输入框里不提交
    // ——真机实录：给 Codex CLI 发「1」，`> 1` 一直躺在 composer 里。
    // shell 那边不受影响：canonical 模式的行规程有 ICRNL，CR 照样当换行。
    const result = writeToTerminalSession(sessionId, pressEnter ? `${input}\r` : input);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'write failed', code: 'WRITE_FAILED' };
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('terminal_write injected', { sessionId, pressEnter });
    return {
      ok: true,
      output: `Typed into the terminal${pressEnter ? ' and pressed Enter' : ' (Enter NOT pressed)'}: ${input}\n`
        + 'This only means the keystrokes were delivered. Call terminal_read or terminal_wait and look at '
        + 'the screen before saying anything about whether the program accepted or processed them.',
      meta: { sessionId, pressEnter, injected: input, riskLevel: validation.riskLevel },
    };
  }
}

// ----------------------------------------------------------------------------
// terminal_wait
// ----------------------------------------------------------------------------

class TerminalWaitHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = terminalWaitSchema;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
    const sessionId = resolveSessionId(args, ctx);
    if (!getTerminalSnapshot(sessionId)) {
      return { ok: false, error: NO_SESSION_HINT, code: 'NOT_FOUND' };
    }

    const timeoutMs = clamp(args.timeout_ms, DEFAULT_WAIT_MS, MAX_WAIT_MS);
    const quietMs = clamp(args.quiet_ms, DEFAULT_QUIET_MS, timeoutMs);
    let matcher: RegExp | null = null;
    if (typeof args.match === 'string' && args.match.length > 0) {
      try {
        matcher = new RegExp(args.match);
      } catch (err) {
        return {
          ok: false,
          error: `match is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
          code: 'INVALID_ARGS',
        };
      }
    }

    const startedAt = Date.now();
    let lastLength = getTerminalSnapshot(sessionId)?.data.length ?? 0;
    let lastChangeAt = startedAt;
    let reason: 'matched' | 'settled' | 'timeout' | 'exited' = 'timeout';

    while (Date.now() - startedAt < timeoutMs) {
      if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
      const snapshot = getTerminalSnapshot(sessionId);
      if (!snapshot) return { ok: false, error: NO_SESSION_HINT, code: 'NOT_FOUND' };

      if (snapshot.data.length !== lastLength) {
        lastLength = snapshot.data.length;
        lastChangeAt = Date.now();
      }
      if (matcher?.test(stripTerminalControlCodes(snapshot.data))) {
        reason = 'matched';
        break;
      }
      if (!snapshot.alive) {
        reason = 'exited';
        break;
      }
      if (Date.now() - lastChangeAt >= quietMs) {
        reason = 'settled';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }

    const snapshot = getTerminalSnapshot(sessionId);
    const output = readTerminalTail(snapshot?.data ?? '', DEFAULT_TAIL_LINES);
    return {
      ok: true,
      output: `[${reason}]\n${output}`,
      meta: { sessionId, reason, waitedMs: Date.now() - startedAt },
    };
  }
}

// ----------------------------------------------------------------------------

export const terminalListModule: ToolModule<Record<string, unknown>, string> = {
  schema: terminalListSchema,
  createHandler: () => new TerminalListHandler(),
};

export const terminalReadModule: ToolModule<Record<string, unknown>, string> = {
  schema: terminalReadSchema,
  createHandler: () => new TerminalReadHandler(),
};

export const terminalWriteModule: ToolModule<Record<string, unknown>, string> = {
  schema: terminalWriteSchema,
  createHandler: () => new TerminalWriteHandler(),
};

export const terminalWaitModule: ToolModule<Record<string, unknown>, string> = {
  schema: terminalWaitSchema,
  createHandler: () => new TerminalWaitHandler(),
};
