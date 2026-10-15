// ============================================================================
// RunHandoffMessage - `!run` 卡「发给 Neo」按钮的消息正文（N-IACT-RUN-HANDOFF-NEO）
// ============================================================================
// 纯函数：命令 + 结果 + 文案 → 一条普通用户消息的正文。设计对齐 gemini-cli 的
// addShellCommandToGeminiHistory（shell 结果以 role:user 汇报进历史）与 Claude Code
// shell mode（命令与输出进上下文），差异是业主拍板的「点击才发」：不点不发、
// 无自动注入。正文是「我跑了什么、结果如何」的汇报口吻，不是新指令，避免模型
// 把它当独立命令重跑（iactChipConfirmation 同因，但那条路要包用户表态模板，
// 这里的正文本身就是表态，直接发）。
// - 脱敏：command / output / reason 都过 redactCredentialText（与 host 工具结果
//   同一规则，redacted 标记同款）；
// - 去 ANSI（N-IACT-RUN-HANDOFF-NEO-FU1）：output 先剥转义序列再进正文——PTY 的
//   颜色码对用户和模型都是噪音；剥在脱敏与截断之前，10000 上限只数可见字符，
//   转义码也不会把密钥切成两半躲过脱敏；剥完为空视同无输出（不发输出块）；
// - 截断：先脱敏再截断（截断缝里不能漏出半个未脱敏的密钥）；超 10000 字符保
//   头 2000 + 尾 8000，中间插一行省略说明（上限与 gemini-cli 一致）；
// - 围栏：比内容里最长的反引号连跑长，否则内容会提前闭合代码块。

import { redactCredentialText } from '@shared/security/secretPatterns';
import { stripAnsi } from '../../../../utils/stripAnsi';
import type { Translations } from '../../../../i18n';

/** 四态里允许交接给 Neo 的三态；denied（用户自己拒的）不发 */
export type RunHandoffStatus = 'completed' | 'refused' | 'failed';

interface RunHandoffInput {
  command: string;
  status: RunHandoffStatus;
  output: string;
  exitCode?: number;
  reason?: string;
}

const REDACTED = '***REDACTED***';
const OUTPUT_MAX_CHARS = 10000;
const OUTPUT_HEAD_CHARS = 2000;
const OUTPUT_TAIL_CHARS = 8000;

/** 围栏长度 = max(3, 内容里最长反引号连跑 + 1) */
function fenceFor(content: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of content) {
    run = ch === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function fencedBlock(content: string): string {
  const fence = fenceFor(content);
  return `${fence}\n${content}\n${fence}`;
}

function truncateOutput(output: string, noteFor: (omitted: number) => string): string {
  if (output.length <= OUTPUT_MAX_CHARS) return output;
  const omitted = output.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
  return `${output.slice(0, OUTPUT_HEAD_CHARS)}\n${noteFor(omitted)}\n${output.slice(output.length - OUTPUT_TAIL_CHARS)}`;
}

export function buildRunHandoffMessage(input: RunHandoffInput, locale: Translations['deliveryExperience']): string {
  const command = redactCredentialText(input.command, { redacted: REDACTED });
  const statusText = input.status === 'completed' ? locale.runStateCompleted
    : input.status === 'refused' ? locale.runStateRefused
    : locale.runStateFailed;
  const statusLine = input.status === 'completed' && input.exitCode !== undefined
    ? statusText + locale.labelSeparator + locale.runExitCode.replace('{code}', String(input.exitCode))
    : statusText;
  const reason = input.reason !== undefined && input.reason !== ''
    ? redactCredentialText(input.reason, { redacted: REDACTED })
    : null;
  // 剥 ANSI 在脱敏与截断之前：上限只数可见字符，转义码也不能把密钥切成两半
  const strippedOutput = stripAnsi(input.output);
  const output = strippedOutput !== ''
    ? truncateOutput(
      redactCredentialText(strippedOutput, { redacted: REDACTED }),
      (omitted) => locale.runHandoffTruncationNote.replace('{count}', String(omitted)),
    )
    : null;

  const parts = [
    locale.runHandoffIntro,
    '',
    locale.runHandoffCommandLabel,
    fencedBlock(command),
    statusLine,
  ];
  if (reason !== null) parts.push(locale.runHandoffReasonLine.replace('{reason}', reason));
  if (output !== null) parts.push(locale.runHandoffOutputLabel, fencedBlock(output));
  return parts.join('\n');
}
