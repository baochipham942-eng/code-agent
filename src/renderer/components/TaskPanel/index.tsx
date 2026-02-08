// ============================================================================
// TaskPanel - Right-side task panel with Linear-style design
// Displays: Gen selector, Progress, Working Folder, Connectors, Agents, Skills
// ============================================================================

import React from 'react';
import { Progress } from './Progress';
import { WorkingFolder } from './WorkingFolder';
import { Connectors } from './Connectors';
import { Agents } from './Agents';
import { Skills } from './Skills';
import { GenerationBadge } from '../GenerationBadge';
import { useI18n } from '../../hooks/useI18n';

export const TaskPanel: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="w-80 border-l border-white/[0.06] bg-[#1c1c21] flex flex-col">
      {/* Header - with Gen selector on the right, aligned with Progress chevron */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <span className="text-sm font-medium text-zinc-400">{t.taskPanel.title}</span>
        <GenerationBadge />
      </div>

      {/* Content - glassmorphism sections */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <Progress />
        <WorkingFolder />
        <Connectors />
        <Agents />
        <Skills />
      </div>
    </div>
  );
};

export default TaskPanel;
