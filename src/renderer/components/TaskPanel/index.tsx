// ============================================================================
// TaskPanel - Right-side task panel with Linear-style design
// Displays: Progress, Working Folder, Context, Connectors
// ============================================================================

import React from 'react';
import { X } from 'lucide-react';
import { Progress } from './Progress';
import { WorkingFolder } from './WorkingFolder';
import { Context } from './Context';
import { Connectors } from './Connectors';

interface TaskPanelProps {
  onClose: () => void;
}

export const TaskPanel: React.FC<TaskPanelProps> = ({ onClose }) => {
  return (
    <div className="w-80 border-l border-zinc-800/50 bg-surface-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/50">
        <span className="text-sm font-medium text-zinc-300">Task Info</span>
        <button
          onClick={onClose}
          className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <Progress />
        <WorkingFolder />
        <Context />
        <Connectors />
      </div>
    </div>
  );
};

export default TaskPanel;
