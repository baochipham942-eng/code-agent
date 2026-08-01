// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

// 分流表述照搬调研 §2.3：一次性命令是 bash 的活，交互式/长会话/用户已登录的 CLI 才是这里的活。
// 写进每个工具的 description，让模型在选工具那一刻就看得到，而不是靠外层 prompt 提醒。
const ROUTING = `When to use this instead of bash:
- Use bash for one-shot commands that start, finish, and hand back output (build, test, grep, git).
- Use terminal_* only for the shared interactive terminal the user has open in the right rail:
  a long-running interactive session, a REPL, or a CLI the USER has already logged into
  (e.g. they ran \`grok login\` themselves). You get their live session, including its auth state.
- Never open a "new shell" here to run a one-shot command. That is what bash is for.`;

export const terminalListSchema: ToolSchema = {
  name: 'terminal_list',
  description: `Lists the interactive terminal sessions the user has open, with their shell, working directory and whether they are still alive.

${ROUTING}`,
  inputSchema: { type: 'object', properties: {} },
  category: 'shell',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

export const terminalReadSchema: ToolSchema = {
  name: 'terminal_read',
  description: `Reads recent output from the user's interactive terminal. Output is stripped of terminal control codes and truncated to the most recent lines.

${ROUTING}`,
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Terminal to read. Defaults to the current conversation\'s terminal.',
      },
      tail_lines: {
        type: 'number',
        description: 'How many trailing lines to return (default 100, max 500).',
      },
    },
  },
  category: 'shell',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

export const terminalWriteSchema: ToolSchema = {
  name: 'terminal_write',
  description: `Types into the user's interactive terminal, as if they typed it themselves. What you send is echoed into their terminal so they can see it.

This shares the user's live session — it can act with their logged-in credentials. Every write goes through the same command safety checks and approval flow as bash.

If the terminal is sitting on a password, passphrase, PIN or verification-code prompt, this tool refuses: the user has to type that themselves. Do not try to work around it.

A successful result means the keystrokes were delivered — NOT that the program accepted, understood or finished them. Always call terminal_read (or terminal_wait) afterwards and look at the screen before you tell the user anything about what happened. Never report "it received the input" or "it is processing" from the write result alone.

${ROUTING}`,
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'The text to type into the terminal.',
      },
      session_id: {
        type: 'string',
        description: 'Terminal to write to. Defaults to the current conversation\'s terminal.',
      },
      pressEnter: {
        type: 'boolean',
        description: 'Press Enter after the text (default true). Required to submit anything to a full-screen TUI '
          + '(Codex CLI, claude, vim, less…): those read raw key events and only accept a real Enter keypress. '
          + 'Set false only to type without submitting.',
      },
    },
    required: ['input'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};

export const terminalWaitSchema: ToolSchema = {
  name: 'terminal_wait',
  description: `Waits for the user's interactive terminal to settle or to print something matching a pattern, then returns the recent output. Use after terminal_write instead of guessing how long a command takes.

${ROUTING}`,
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Terminal to wait on. Defaults to the current conversation\'s terminal.',
      },
      match: {
        type: 'string',
        description: 'Regular expression. Returns as soon as recent output matches it.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Give up after this long (default 15000, max 120000).',
      },
      quiet_ms: {
        type: 'number',
        description: 'Consider the terminal settled after this long with no new output (default 800).',
      },
    },
  },
  category: 'shell',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: false,
};
