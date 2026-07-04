// ============================================================================
// StreamingIndicator — 生成期间的「安静在场」信号
//
//   active   ：一个呼吸光标 = 「还活着」。无计时、无升级，覆盖绝大多数回合，
//              包括健康地跑了好几分钟的长生成 —— 长 ≠ 异常，跳秒表只会制造焦虑。
//   long-tool：唯一值得浮现的「真信号」—— 某个工具确实跑了很久。给一条中性、
//              平静的提示（绝不用警告色/惊悚措辞），并附运行时长。
// ============================================================================

import React, { useState, useEffect } from 'react';
import { StopCircle } from 'lucide-react';
import type { TraceNode } from '@shared/contract/trace';
import { useI18n } from '../../../hooks/useI18n';

interface StreamingIndicatorProps {
  /** 回合开始时间。保留给调用方语义，不再用于「按耗时升级」。 */
  startTime: number;
  runningToolStartTime?: number;
  onForceStop?: () => void;
  /** 正文已自带内联光标时（正在流式输出文字），状态槽隐去光标避免重复。 */
  showCaret?: boolean;
  /** 当前正在接收思考/推理增量（尚无可见正文、也不是在等工具）。 */
  isThinking?: boolean;
}

// 工具真正连续运行到这个时长，才是唯一值得提示的条件。
// 回合总耗时不算 —— 健康生成动辄数分钟，那里放计时器只会徒增焦虑。
const LONG_TOOL_NOTICE_SECONDS = 45;

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export type StreamingIndicatorMode = 'active' | 'long-tool';

export function getStreamingIndicatorState(
  runningToolElapsedSeconds?: number,
): { mode: StreamingIndicatorMode; longRunningTool: boolean } {
  const longRunningTool =
    typeof runningToolElapsedSeconds === 'number' &&
    runningToolElapsedSeconds >= LONG_TOOL_NOTICE_SECONDS;
  return {
    mode: longRunningTool ? 'long-tool' : 'active',
    longRunningTool,
  };
}

export function getRunningToolStartTime(nodes: TraceNode[]): number | undefined {
  const runningStarts = nodes
    .filter((node) => {
      const toolCall = node.toolCall;
      if (!toolCall) return false;
      if (toolCall._streaming) return false;
      return toolCall.success === undefined && toolCall.result === undefined;
    })
    .map((node) => node.timestamp);

  return runningStarts.length > 0 ? Math.min(...runningStarts) : undefined;
}

export const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({
  runningToolStartTime,
  onForceStop,
  showCaret = true,
  isThinking = false,
}) => {
  const { t } = useI18n();
  const [runningToolElapsed, setRunningToolElapsed] = useState<number | undefined>(undefined);

  useEffect(() => {
    const update = () => {
      setRunningToolElapsed(
        runningToolStartTime !== undefined
          ? Math.floor((Date.now() - runningToolStartTime) / 1000)
          : undefined,
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [runningToolStartTime]);

  const { mode } = getStreamingIndicatorState(runningToolElapsed);

  // 长跑工具 —— 唯一真正值得浮现的状态。中性、平静、信息性：不用警告色，不用惊悚措辞。
  if (mode === 'long-tool') {
    return (
      <div className="flex items-center gap-2 py-1 text-zinc-400">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
        <span className="text-xs">执行中</span>
        {runningToolElapsed !== undefined && (
          <span className="text-xs font-mono text-zinc-500">{formatElapsed(runningToolElapsed)}</span>
        )}
        {onForceStop && (
          <button
            onClick={onForceStop}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-500/10 hover:bg-zinc-500/20 border border-zinc-500/30 rounded transition-colors"
          >
            <StopCircle className="w-3 h-3" />
            停止
          </button>
        )}
      </div>
    );
  }

  // active：仅一个呼吸光标 = 「还活着」，别无他物。正文正在流式时由正文自带光标，此处隐去。
  if (!showCaret) return null;

  // 正在接收思考增量：扫光文字替代光标，思考阶段一结束（isThinking 转 false 或
  // showCaret 转 false）这个分支就不再命中，不留残影。
  if (isThinking) {
    return (
      <div className="py-1" aria-label={t.chat.thinking}>
        <span className="streaming-thinking-shimmer text-xs font-medium">{t.chat.thinking}</span>
      </div>
    );
  }

  return (
    <div className="py-1" aria-label="生成中">
      <span className="streaming-caret text-sm leading-none">▎</span>
    </div>
  );
};
