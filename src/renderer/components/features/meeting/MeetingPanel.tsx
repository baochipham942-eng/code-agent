// ============================================================================
// MeetingPanel - 会议记录面板容器（覆盖层模式）
// ============================================================================

import React from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { MeetingRecorder } from './MeetingRecorder';

export const MeetingPanel: React.FC = () => {
  const { setShowMeetingPanel } = useAppStore();

  return (
    <div className="fixed inset-0 z-50 flex bg-black/60" onClick={() => setShowMeetingPanel(false)}>
      <div
        className="m-auto w-full max-w-lg bg-zinc-900 rounded-2xl border border-zinc-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-200">会议记录</h2>
          <button
            onClick={() => setShowMeetingPanel(false)}
            className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          <MeetingRecorder />
        </div>
      </div>
    </div>
  );
};
