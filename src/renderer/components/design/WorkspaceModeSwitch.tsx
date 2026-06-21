// Code / 设计 顶层工作区切换器（Kun 借鉴）。放在 TitleBar 与设计页表头，
// 两处共用，点击切换 workspaceMode。
import React from 'react';
import { Code2, Palette } from 'lucide-react';
import { useWorkspaceModeStore, type WorkspaceMode } from '../../stores/workspaceModeStore';
import { useI18n } from '../../hooks/useI18n';

export const WorkspaceModeSwitch: React.FC = () => {
  const { t } = useI18n();
  const workspaceMode = useWorkspaceModeStore((s) => s.workspaceMode);
  const setWorkspaceMode = useWorkspaceModeStore((s) => s.setWorkspaceMode);

  const items: Array<{ mode: WorkspaceMode; label: string; icon: React.ReactNode }> = [
    { mode: 'code', label: t.design.tabCode, icon: <Code2 className="h-3.5 w-3.5" /> },
    { mode: 'design', label: t.design.tabDesign, icon: <Palette className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="window-no-drag inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
      {items.map(({ mode, label, icon }) => {
        const active = workspaceMode === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => setWorkspaceMode(mode)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
              active
                ? 'bg-white/[0.10] text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
            }`}
          >
            {icon}
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
};
