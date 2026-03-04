// ============================================================================
// MeetingRecorder - 会议录音主组件
// ============================================================================

import React, { useCallback } from 'react';
import { useMeetingRecorder, MeetingStatus } from '../../../hooks/useMeetingRecorder';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const statusLabels: Record<MeetingStatus, string> = {
  idle: '',
  recording: '录音中',
  saving: '正在保存录音...',
  transcribing: '正在转写...',
  generating: '正在生成会议纪要...',
  done: '完成',
  error: '出错',
};

export const MeetingRecorder: React.FC = () => {
  const {
    status,
    duration,
    error,
    result,
    startRecording,
    stopRecording,
    reset,
  } = useMeetingRecorder();

  const handleCopy = useCallback(async () => {
    if (result?.minutes) {
      await navigator.clipboard.writeText(result.minutes);
    }
  }, [result]);

  const handleSaveFile = useCallback(async () => {
    if (!result?.minutes) return;
    const blob = new Blob([result.minutes], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meeting-minutes-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  // 处理中状态（saving/transcribing/generating）
  const isProcessing = status === 'saving' || status === 'transcribing' || status === 'generating';

  return (
    <div className="flex flex-col h-full p-4 space-y-4">
      {/* Idle: 开始按钮 */}
      {status === 'idle' && (
        <div className="flex flex-col items-center justify-center flex-1 space-y-4">
          <button
            onClick={startRecording}
            className="flex items-center gap-2 px-6 py-3 text-lg font-medium text-white bg-red-600 rounded-full hover:bg-red-700 transition-colors"
          >
            <span className="w-3 h-3 rounded-full bg-white" />
            开始会议录音
          </button>
          <p className="text-sm text-zinc-400">点击开始录制，录音将自动保存到本地</p>
        </div>
      )}

      {/* Recording: 录音中 */}
      {status === 'recording' && (
        <div className="flex flex-col items-center justify-center flex-1 space-y-6">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-2xl font-mono text-zinc-100">{formatDuration(duration)}</span>
          </div>
          <button
            onClick={stopRecording}
            className="flex items-center gap-2 px-6 py-3 font-medium text-white bg-zinc-600 rounded-full hover:bg-zinc-700 transition-colors"
          >
            <span className="w-3 h-3 rounded-sm bg-white" />
            停止录音
          </button>
        </div>
      )}

      {/* Processing: 处理中 */}
      {isProcessing && (
        <div className="flex flex-col items-center justify-center flex-1 space-y-4">
          <div className="w-8 h-8 border-2 border-zinc-400 border-t-blue-500 rounded-full animate-spin" />
          <p className="text-sm text-zinc-300">{statusLabels[status]}</p>
        </div>
      )}

      {/* Done: 结果展示 */}
      {status === 'done' && result && (
        <div className="flex flex-col flex-1 space-y-3 overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">
              模型: {result.model} | 时长: {formatDuration(Math.round(result.duration))}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto rounded-lg bg-zinc-800 p-4">
            <pre className="whitespace-pre-wrap text-sm text-zinc-200 font-sans">
              {result.minutes}
            </pre>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              className="px-4 py-2 text-sm bg-zinc-700 text-zinc-200 rounded hover:bg-zinc-600 transition-colors"
            >
              复制到剪贴板
            </button>
            <button
              onClick={handleSaveFile}
              className="px-4 py-2 text-sm bg-zinc-700 text-zinc-200 rounded hover:bg-zinc-600 transition-colors"
            >
              保存为文件
            </button>
            <button
              onClick={reset}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              新的录音
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="flex flex-col items-center justify-center flex-1 space-y-4">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={reset}
            className="px-4 py-2 text-sm bg-zinc-700 text-zinc-200 rounded hover:bg-zinc-600 transition-colors"
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
};
