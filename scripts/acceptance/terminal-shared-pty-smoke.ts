// ============================================================================
// terminal-shared-pty-smoke —— 真 PTY 冒烟（Term-P0/P1 验收 ①③ 的宿主侧）
//
// 单测里 node-pty 是替身，验的是闸门顺序和缓冲语义，验不到「真的能开出一个 shell、
// 真的能跑命令、Agent 那条读写路径拿到的确实是同一个终端」。这个脚本把那一层补上：
// 真起 PTY → 用户侧写 → Agent 侧 terminal_read 读回 → Agent 侧 terminal_write 注入
// → 核对回显可见 + 拒填生效。
//
// 不进 CI（会起真 shell）。手动跑：npm run acceptance:terminal-shared-pty
// 仍需人验的：xterm 渲染、键盘往返、真第三方 CLI 的登录态继承（见批次报告 §4）。
// ============================================================================

import os from 'node:os';
import {
  disposeTerminalSession,
  getTerminalSnapshot,
  openTerminalSession,
  writeToTerminalSession,
} from '../../src/host/services/terminal/terminalSessionManager.ts';
import {
  isAwaitingSecretInput,
  readTerminalTail,
  terminalReadModule,
  terminalWriteModule,
} from '../../src/host/tools/modules/terminal/terminal.ts';
import type { CanUseToolFn, ToolContext } from '../../src/host/protocol/tools.ts';

const SESSION_ID = `acceptance-terminal-${process.pid}`;

const ctx = {
  sessionId: SESSION_ID,
  workingDir: os.tmpdir(),
  abortSignal: new AbortController().signal,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as ToolContext;

const approve: CanUseToolFn = async () => ({ allow: true });

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function waitForOutput(match: RegExp, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (match.test(getTerminalSnapshot(SESSION_ID)?.data ?? '')) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// createHandler 允许同步或异步返回，别假设它是 Promise
async function handlerOf(module: { createHandler(): unknown }) {
  return (await Promise.resolve(module.createHandler())) as {
    execute(a: Record<string, unknown>, c: ToolContext, p: CanUseToolFn): Promise<
      { ok: true; output: string } | { ok: false; error: string; code?: string }
    >;
  };
}

async function readTool(): Promise<string> {
  const result = await (await handlerOf(terminalReadModule)).execute({}, ctx, approve);
  return result.ok ? result.output : `<error: ${result.error}>`;
}

async function main(): Promise<void> {
  const snapshot = openTerminalSession({ sessionId: SESSION_ID, cwd: os.tmpdir() });
  check('① 真 PTY 起得来', snapshot.alive, `shell=${snapshot.shell}`);

  // ① 用户自己敲命令，看得到输出
  writeToTerminalSession(SESSION_ID, 'echo neo-user-marker\n');
  check('① 用户敲的命令跑出了结果', await waitForOutput(/neo-user-marker/));

  // ② Agent 读回的是同一个终端，且已清洗控制码
  const readBack = await readTool();
  check('② Agent terminal_read 读到同一个终端', readBack.includes('neo-user-marker'));
  // eslint-disable-next-line no-control-regex -- 就是要断言输出里没有裸 ANSI
  check('② 读回内容不含裸 ANSI 控制码', !/\x1b\[/.test(readBack));

  // ② Agent 注入，且注入对用户可见
  const write = await (await handlerOf(terminalWriteModule))
    .execute({ input: 'echo neo-agent-marker' }, ctx, approve);
  check('② Agent terminal_write 注入成功', write.ok, write.ok ? '' : write.error);
  check('② 注入结果落在同一个终端', await waitForOutput(/neo-agent-marker/));
  check(
    '② 注入对用户可见（终端里印出 [Neo] …）',
    (getTerminalSnapshot(SESSION_ID)?.data ?? '').includes('[Neo] echo neo-agent-marker'),
  );

  // ③ 全屏 TUI 形态：raw 模式应用只认 CR(13) 当 Enter。
  // 用 raw 模式读两个字节的 python 当最小 TUI 替身——比起真起一个 Codex CLI，
  // 它直接把「到底哪个字节到达了应用」摆出来，正是缺陷本身。
  // ponytail: 不起真 TUI，要验渲染另说；这里只验提交键语义。
  const RAW_KEY_READER = 'python3 -c "import sys,tty,termios; fd=sys.stdin.fileno();'
    + " old=termios.tcgetattr(fd); tty.setraw(fd); b=sys.stdin.read(2);"
    + " termios.tcsetattr(fd,termios.TCSADRAIN,old);"
    + " print('RAWKEYS='+','.join(str(ord(c)) for c in b))\"";
  writeToTerminalSession(SESSION_ID, `${RAW_KEY_READER}\r`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const tuiWrite = await (await handlerOf(terminalWriteModule))
    .execute({ input: 'x' }, ctx, approve);
  check('③ 向 raw 模式应用写入成功', tuiWrite.ok, tuiWrite.ok ? '' : tuiWrite.error);
  // ⚠️ 匹配必须带上数字：命令源码本身就含 `RAWKEYS=`，它会被 shell 立刻回显，
  // 只匹配裸标记会命中回显那一行（今天第二次踩这个坑了）。
  const KEYS_OUTPUT = /RAWKEYS=\d+,\d+/;
  const sawKeys = await waitForOutput(KEYS_OUTPUT, 8_000);
  const keyLine = readTerminalTail(getTerminalSnapshot(SESSION_ID)?.data ?? '', 40)
    .split('\n').find((entry) => KEYS_OUTPUT.test(entry)) ?? '';
  check(
    '③ 提交键以 CR(13) 到达全屏 TUI，不是 LF(10)',
    sawKeys && keyLine.includes('RAWKEYS=120,13'),
    keyLine || '<超时——提交键从没到达 raw 应用>',
  );

  // 密码 prompt 拒填：必须用**真的会阻塞等输入**的命令。
  // 光 `printf 'Password: '` 不行——它立刻返回，zsh 的 prompt 会当场重画覆盖掉那行
  // （第一版就是这么写的，于是"没检测到"，其实是终端里根本已经没有那个提示了）。
  //
  // ⚠️ 等待条件必须是「终端真的停在提示上」，不能是「输出里出现过 Password」——
  // 用户按下的键会被 shell 立刻回显，`Password: ` 在**命令还没开始跑**的那一刻就已经
  // 出现在流里了。按后者等，探针会在回显那一瞬间就放行，测的是命令行本身不是提示，
  // 于是「没检测到」——假阴性出在探针，不在产品。
  writeToTerminalSession(SESSION_ID, "printf 'Password: '; read -r ignored\n");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000
    && !isAwaitingSecretInput(getTerminalSnapshot(SESSION_ID)?.data ?? '')) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(
    '安全 密码提示确实停在终端上（前置条件）',
    isAwaitingSecretInput(getTerminalSnapshot(SESSION_ID)?.data ?? ''),
  );
  const refused = await (await handlerOf(terminalWriteModule))
    .execute({ input: 'hunter2' }, ctx, approve);
  check(
    '安全 密码 prompt 上拒填并要求用户接管',
    !refused.ok && refused.code === 'NEEDS_USER_TAKEOVER',
    refused.ok ? '竟然写进去了' : refused.error.slice(0, 60),
  );

  disposeTerminalSession(SESSION_ID);
  check('清理 dispose 后会话不再存在', getTerminalSnapshot(SESSION_ID) === null);
}

main()
  .then(() => {
    console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(' / ')}`);
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((err: unknown) => {
    disposeTerminalSession(SESSION_ID);
    console.error('acceptance crashed:', err);
    process.exit(1);
  });
