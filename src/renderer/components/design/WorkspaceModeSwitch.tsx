// Code / 设计 顶层工作区切换器（Kun 借鉴）。放在 TitleBar 与设计页表头，
// 两处共用，点击切换 workspaceMode。
import React from 'react';
import { Code2, Palette } from 'lucide-react';
import { useWorkspaceModeStore, type WorkspaceMode } from '../../stores/workspaceModeStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useDesignCanvasStore } from './designCanvasStore';
import { useI18n } from '../../hooks/useI18n';

/**
 * 切换顶层工作区模式 + 编排设计模式会话化收口：
 * - 切到「设计」且有当前会话：标记会话设计激活 + 认领画布属主 + 自动打开 design-canvas tab，
 *   让用户切到设计即可直接对话出图（贴 Lovart/OpenDesign），不再弹全屏表单。
 * - 切到「设计」但无当前会话：只切 mode，不激活会话化画布。
 * - 切到「通用」：关闭旧表单覆盖层旗标，避免 code 模式残留表单。
 */
export function switchWorkspaceMode(mode: WorkspaceMode): void {
  useWorkspaceModeStore.getState().setWorkspaceMode(mode);
  if (mode === 'design') {
    const sid = useSessionStore.getState().currentSessionId;
    if (sid) {
      useDesignCanvasStore.getState().markSessionDesignActive(sid);
      useDesignCanvasStore.getState().claimCanvasForSession(sid);
      useAppStore.getState().openWorkbenchTab('design-canvas', { source: 'auto' });
    }
  } else {
    useWorkspaceModeStore.getState().setDesignFormOpen(false);
  }
}

export const WorkspaceModeSwitch: React.FC = () => {
  const { t } = useI18n();
  const workspaceMode = useWorkspaceModeStore((s) => s.workspaceMode);

  const items: Array<{ mode: WorkspaceMode; label: string; icon: React.ReactNode }> = [
    { mode: 'code', label: t.design.tabCode, icon: <Code2 className="h-3.5 w-3.5" /> },
    { mode: 'design', label: t.design.tabDesign, icon: <Palette className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
      {items.map(({ mode, label, icon }) => {
        const active = workspaceMode === mode;
        return (
          // ds-allow:start 分段控件段（active/inactive 互斥态用自定义 bg-white/[0.10]，非 Button 任一 variant）
          <button
            key={mode}
            type="button"
            onClick={() => switchWorkspaceMode(mode)}
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
          // ds-allow:end
        );
      })}
    </div>
  );
};
