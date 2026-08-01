import React, { useState } from 'react';
import { Layers } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { IconButton } from '../primitives';
import { DesignCanvas } from './DesignCanvas';
import { useDesignCanvasStore } from './designCanvasStore';
import { useRestoreCanvasFromDisk } from './useRestoreCanvasFromDisk';
import type { DesignCanvasSidePanelTab } from './DesignCanvasSidePanel';

/**
 * 把 konva 设计画布作为「产物预览面」挂进专属 workbench tab。
 * 薄容器：给 DesignCanvas 一个 h-full w-full 的尺寸盒（Stage 需显式像素宽高，
 * 由 DesignCanvas 内部 ResizeObserver 跟随），并复用共享的画布磁盘恢复 hook。
 * 外层容器挂 data-testid="design-canvas-tab" 供交互测试定位。
 *
 * 边栏归一（2026-08-01 工单①）：图层 + 设计历史合并成同一个边栏面板（面板内两个 tab），
 * 右缘细边栏只剩一个图标；点图标浮出面板（压在画布上），再点图标 / 点画布空白处收回。
 * 空画布没有图层可言——此时打开面板默认落「历史」tab。
 */
export const DesignCanvasTab: React.FC = () => {
  const { t } = useI18n();
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<DesignCanvasSidePanelTab>('layers');
  const hasNodes = useDesignCanvasStore((s) => s.nodes.length > 0);

  // 画布恢复：runDir 已持久化但节点为空（刷新 / 独立挂载）→ 从磁盘 canvas.json 重载。
  useRestoreCanvasFromDisk();

  const togglePanel = (): void => {
    setPanelOpen((current) => {
      const next = !current;
      if (next && !hasNodes) setPanelTab('history');
      return next;
    });
  };

  return (
    <div data-testid="design-canvas-tab" className="relative h-full w-full bg-zinc-950">
      <DesignCanvas
        showErrorBar
        sidePanelOpen={panelOpen}
        sidePanelTab={panelTab}
        onSidePanelTabChange={setPanelTab}
        onCanvasBlankPointerDown={() => setPanelOpen(false)}
      />
      {/* 右缘图标细边栏（垂直居中，只剩一个图标）：顶区是顶条/导出按钮、底区有淘汰托盘/对比 CTA，
          细边栏都不许撞；浮出的面板让到 right-12，细边栏全程可达（再点图标收回）。 */}
      <div
        data-testid="design-canvas-panel-rail"
        className="absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1"
      >
        <IconButton
          type="button"
          variant="outline"
          size="sm"
          data-testid="design-canvas-sidepanel-toggle"
          aria-label={panelOpen ? t.design.sidePanelCollapse : t.design.sidePanelExpand}
          aria-expanded={panelOpen}
          title={panelOpen ? t.design.sidePanelCollapse : t.design.sidePanelExpand}
          onClick={togglePanel}
          icon={<Layers className="h-full w-full" />}
          className="bg-zinc-950/85 shadow-lg backdrop-blur"
        />
      </div>
    </div>
  );
};
