import type { ToolCall } from '@shared/contract';

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

  return (
    <div className="animate-fadeIn">
      <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
        <span>Live output</span>
        <div className="flex-1 h-px bg-gray-700/50" />
      </div>
      <pre className="text-xs text-gray-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border border-gray-800/50 whitespace-pre-wrap break-words">
        {stripAnsiCodes(liveOutput)}
      </pre>
    </div>
  );
}
