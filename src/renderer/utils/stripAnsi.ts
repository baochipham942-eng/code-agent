// ============================================================================
// stripAnsi - 剥掉 PTY 输出里的 ANSI 转义序列（N-IACT-RUN-HANDOFF-NEO-FU1）
// ============================================================================
// `!run` 卡的两条出口（卡片展示、发给 Neo 的消息正文）都要给人读 / 给模型读，
// 颜色码是纯噪音：真实 `ls work` 的输出是一堆 `ESC[34m…ESC[39;49mESC[0m`。
// 纯文本走快速路径原样返回（值与 === 都不动）。正则用 String.fromCharCode 拼
// 控制字节，不写字面控制符，no-control-regex 才不报。仓里四处私有副本
// （ToolCallDisplay / LiveToolOutput / ToolDetails / cliConnector）不归本单管，
// 别顺手合并。

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);

// 三类序列，最具体的放最前（OSC 收尾符没找到时由 CSI / 其余 ESC 兜底）：
// - OSC：ESC ] 开头，BEL 或 ST（ESC \）收尾（终端标题）；
// - CSI：ESC [（或单字节 0x9b）+ 参数字节 0x30-0x3f + 中间字节 0x20-0x2f + 最终字节 0x40-0x7e；
// - 其余 ESC 序列：ESC + 中间字节* + 最终字节（ESC 7 存光标、ESC ( B 选字符集这类）。
const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `(?:${ESC}\\[|${C1_CSI})[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]`,
    `${ESC}[\\x20-\\x2f]*[\\x30-\\x7e]`,
  ].join('|'),
  'g',
);

export function stripAnsi(text: string): string {
  if (!text.includes(ESC) && !text.includes(C1_CSI)) return text;
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}
