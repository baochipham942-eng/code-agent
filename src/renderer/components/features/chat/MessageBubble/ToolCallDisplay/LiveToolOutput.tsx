import type { ToolCall } from '@shared/contract';
import { computeBashPreviewLines } from './bashOutputPreview';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\[[0-9;]*[a-zA-Z]|${ESC}\\].*?${BEL}|${ESC}\\[\\??[0-9;]*[a-zA-Z]`,
  'g',
);

function stripAnsiCodes(str: string): string {
  return str.replace(ANSI_SEQUENCE_PATTERN, '');
}

function formatLiveToolOutput(toolCall: ToolCall): string {
  const live = toolCall.liveOutput;
  if (!live) return '';
  return [
    live.stdout || '',
    live.stderr ? `[stderr]\n${live.stderr}` : '',
  ].filter(Boolean).join('\n');
}

export function LiveToolOutput({ toolCall }: { toolCall: ToolCall }) {
  const liveOutput = formatLiveToolOutput(toolCall);
  if (!liveOutput) return null;

  // 全局尾截断（ADR-043 T2 遗留刀1）：这里此前无上限渲染全量 pre 块，长命令运行中
  // 在全展开视图里会无限刷屏。复用 bashOutputPreview 的 isPending=true 分支
  // （尾 N 行 + 折叠 \r 进度帧），不新造截断逻辑。
  const { displayLines, omittedCount } = computeBashPreviewLines(stripAnsiCodes(liveOutput), true);

  return (
    <div className="animate-fadeIn">
      <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
        <span>Live output</span>
        <div className="flex-1 h-px bg-gray-700/50" />
      </div>
      <pre className="text-xs text-gray-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border border-gray-800/50 whitespace-pre-wrap break-words">
        {omittedCount > 0 && `…省略 ${omittedCount} 行…\n`}
        {displayLines.join('\n')}
      </pre>
    </div>
  );
}
