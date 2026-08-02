// 画布边栏归一面板（2026-08-01 工单①）：图层 + 设计历史合并成同一个边栏面板，
// 面板内两个 tab（图层 / 历史）。右缘细边栏因此只剩一个图标，收起时画布只剩图 + 顶部条。
// 壳（定位/宽度/tab 条）在这里；图层内容复用 DesignLayerPanel，历史内容复用 DesignCostHistory。
import React from 'react';
import { History, Layers } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { DesignLayerPanel } from './DesignLayerPanel';
import { DesignCostHistory } from './DesignCostHistory';
import type { CanvasNode } from './designCanvasTypes';

export type DesignCanvasSidePanelTab = 'layers' | 'history';

export const DesignCanvasSidePanel: React.FC<{
  tab: DesignCanvasSidePanelTab;
  onTabChange: (tab: DesignCanvasSidePanelTab) => void;
  nodes: CanvasNode[];
  selectedIds: string[];
  onSelect: (id: string, additive: boolean) => void;
  onRename: (id: string, label: string) => void;
  onSetChosen: (id: string) => void;
  onDiscard: (id: string) => void;
  onDelete: (id: string) => void;
  onFocus: (id: string) => void;
  /** 面板顶缘（px，相对画布容器）。默认 56（top-14）；DesignCanvas 按顶条实测底缘动态传入，
      保证任意栏宽下面板不与顶条重叠（2026-08-01 窄栏遮挡工单）。 */
  topOffset?: number;
  /** 面板右缘（px，相对画布容器）。默认 16（right-4）；从右缘细边栏浮出时传 48 让开细边栏。 */
  rightOffset?: number;
}> = ({
  tab,
  onTabChange,
  nodes,
  selectedIds,
  onSelect,
  onRename,
  onSetChosen,
  onDiscard,
  onDelete,
  onFocus,
  topOffset,
  rightOffset,
}) => {
  const { t } = useI18n();
  const tabs: { id: DesignCanvasSidePanelTab; label: string; icon: React.ReactNode }[] = [
    { id: 'layers', label: t.design.layerPanelTitle, icon: <Layers className="h-3.5 w-3.5" /> },
    { id: 'history', label: t.design.historyPanelTitle, icon: <History className="h-3.5 w-3.5" /> },
  ];
  return (
    // 合并后面板比原图层面板（w-80）更宽——w-96，遮挡回归按「面板展开态」专项覆盖。
    <div
      data-testid="design-canvas-sidepanel"
      className="absolute z-10 flex max-h-[70%] w-96 max-w-[calc(100%_-_5rem)] flex-col overflow-hidden rounded-lg border border-white/[0.10] bg-zinc-950/85 text-xs text-zinc-200 shadow-2xl backdrop-blur"
      style={{ top: topOffset ?? 56, right: rightOffset ?? 16 }}
    >
      <div role="tablist" className="flex items-center gap-1 border-b border-white/[0.08] px-2 py-1.5">
        {/* ds-allow:start tab 按钮沿用画布工具条的紧凑裸 button 样式（与图解工具条/历史面板行内按钮一致；design-mode 整体 W3 收口时统一迁 primitive） */}
        {tabs.map((it) => (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={tab === it.id}
            data-testid={`design-canvas-sidepanel-tab-${it.id}`}
            onClick={() => onTabChange(it.id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
              tab === it.id
                ? 'bg-fuchsia-500/15 text-fuchsia-100'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            }`}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
        {/* ds-allow:end */}
      </div>
      <div className="min-h-0 overflow-y-auto">
        {tab === 'layers' ? (
          <DesignLayerPanel
            nodes={nodes}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onRename={onRename}
            onSetChosen={onSetChosen}
            onDiscard={onDiscard}
            onDelete={onDelete}
            onFocus={onFocus}
          />
        ) : (
          <div
            id="design-cost-history-content"
            data-testid="design-cost-history-content"
            data-collapsed={false}
            className="p-2"
          >
            <DesignCostHistory />
          </div>
        )}
      </div>
    </div>
  );
};
