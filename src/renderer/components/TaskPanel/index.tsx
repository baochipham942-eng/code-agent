// ============================================================================
// TaskPanel - Right-side task panel with Linear-style design
// Displays: Progress, Working Folder, Context, Skills, Connectors
// ============================================================================

import React from 'react';
import { Progress } from './Progress';
import { WorkingFolder } from './WorkingFolder';
import { Context } from './Context';
import { Skills } from './Skills';
import { Connectors } from './Connectors';
import { useI18n } from '../../hooks/useI18n';

export const TaskPanel: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="w-80 border-l border-white/[0.06] bg-transparent flex flex-col backdrop-blur-sm">
      {/* Header - minimal, transparent */}
      <div className="flex items-center px-4 py-3 border-b border-white/[0.06]">
        <span className="text-sm font-medium text-zinc-400">{t.taskPanel.title}</span>
      </div>

      {/* Content - glassmorphism sections */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <Progress />
        <WorkingFolder />
        <Context />
        <Skills />
        <Connectors />
      </div>
    </div>
  );
};

export default TaskPanel;
