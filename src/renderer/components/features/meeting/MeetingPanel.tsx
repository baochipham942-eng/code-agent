// ============================================================================
// MeetingPanel - 会议记录面板容器
// ============================================================================

import React from 'react';
import { MeetingRecorder } from './MeetingRecorder';

export const MeetingPanel: React.FC = () => {
  return (
    <div className="flex flex-col h-full bg-zinc-900">
      <div className="flex items-center px-4 py-3 border-b border-zinc-700">
        <h2 className="text-sm font-medium text-zinc-200">会议记录</h2>
      </div>
      <MeetingRecorder />
    </div>
  );
};
