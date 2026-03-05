// ============================================================================
// MeetingPanel - 全屏会议记录面板
// 对标 Otter.ai / Notta 的全屏录音+实时转录体验
// ============================================================================

import React from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { MeetingRecorder } from './MeetingRecorder';

export const MeetingPanel: React.FC = () => {
  const { setShowMeetingPanel, meetingStatus } = useAppStore();

  const isRecordingActive = meetingStatus === 'recording' || meetingStatus === 'paused';

  const handleClose = () => {
    if (isRecordingActive) return;
    setShowMeetingPanel(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800/60 flex-shrink-0">
        <h2 className="text-sm font-medium text-zinc-300">会议记录</h2>
        <button
          onClick={handleClose}
          disabled={isRecordingActive}
          className={`p-1.5 rounded-lg transition-colors ${
            isRecordingActive
              ? 'text-zinc-700 cursor-not-allowed'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
          }`}
          title={isRecordingActive ? '录音中无法关闭' : '关闭'}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Main content - fills remaining space */}
      <div className="flex-1 overflow-hidden">
        <MeetingRecorder />
      </div>
    </div>
  );
};
