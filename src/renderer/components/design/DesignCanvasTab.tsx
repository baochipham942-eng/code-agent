import React, { useState } from 'react';
import { History, Layers } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { IconButton } from '../primitives';
import { DesignCanvas } from './DesignCanvas';
import { DesignCostHistory } from './DesignCostHistory';
import { useDesignCanvasStore } from './designCanvasStore';
import { useRestoreCanvasFromDisk } from './useRestoreCanvasFromDisk';

/**
 * 把 konva 设计画布作为「产物预览面」挂进专属 workbench tab。
 * 薄容器：给 DesignCanvas 一个 h-full w-full 的尺寸盒（Stage 需显式像素宽高，
 * 由 DesignCanvas 内部 ResizeObserver 跟随），并复用共享的画布磁盘恢复 hook。
 * 外层容器挂 data-testid="design-canvas-tab" 供交互测试定位。
 *
 * 图层面板 + 设计历史默认全部收起（2026-08-01 工单②）：画布常态只剩图 + 顶部条，
 * 两块面板收成右缘一条图标细边栏；点图标浮出对应面板（压在画布上），再点图标 /
 * 点画布空白处收回。两个面板互斥——同开又变回「太多东西挤在同一块画布上」。
 */
export const DesignCanvasTab: React.FC = () => {
  const { t } = useI18n();
  const [openPanel, setOpenPanel] = useState<'layers' | 'history' | null>(null);
  const hasNodes = useDesignCanvasStore((s) => s.nodes.length > 0);

  // 画布恢复：runDir 已持久化但节点为空（刷新 / 独立挂载）→ 从磁盘 canvas.json 重载。
  useRestoreCanvasFromDisk();

  const togglePanel = (panel: 'layers' | 'history'): void => {
    setOpenPanel((current) => (current === panel ? null : panel));
  };

  return (
    <div data-testid="design-canvas-tab" className="relative h-full w-full bg-zinc-950">
      <DesignCanvas
        showErrorBar
        layerPanelOpen={openPanel === 'layers'}
        onCanvasBlankPointerDown={() => setOpenPanel(null)}
      />
      {/* 右缘图标细边栏（垂直居中）：顶区是顶条/导出按钮、底区有淘汰托盘/对比 CTA，
          细边栏都不许撞；浮出的面板统一让到 right-12，细边栏全程可达（再点图标收回）。 */}
      <div
        data-testid="design-canvas-panel-rail"
        className="absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1"
      >
        {hasNodes && (
          <IconButton
            type="button"
            variant="outline"
            size="sm"
            data-testid="design-canvas-layers-toggle"
            aria-label={openPanel === 'layers' ? t.design.layersCollapse : t.design.layersExpand}
            aria-expanded={openPanel === 'layers'}
            title={openPanel === 'layers' ? t.design.layersCollapse : t.design.layersExpand}
            onClick={() => togglePanel('layers')}
            icon={<Layers className="h-full w-full" />}
            className="bg-zinc-950/85 shadow-lg backdrop-blur"
          />
        )}
        <IconButton
          type="button"
          variant="outline"
          size="sm"
          data-testid="design-canvas-history-toggle"
          aria-label={openPanel === 'history' ? t.design.historyCollapse : t.design.historyExpand}
          aria-expanded={openPanel === 'history'}
          title={openPanel === 'history' ? t.design.historyCollapse : t.design.historyExpand}
          onClick={() => togglePanel('history')}
          icon={<History className="h-full w-full" />}
          className="bg-zinc-950/85 shadow-lg backdrop-blur"
        />
      </div>
      {/* 设计历史浮层：从细边栏浮出、压在画布上（展开态直接渲染完整时间线，不再有
          「收起但仍占一条 w-80 标题栏」的中间态——常态画布只剩图 + 顶部条）。 */}
      {openPanel === 'history' && (
        <aside
          data-testid="design-cost-history-dock"
          className="absolute bottom-4 right-12 z-20 w-80 max-w-[calc(100%_-_4rem)]"
        >
          <div
            id="design-cost-history-content"
            data-testid="design-cost-history-content"
            data-collapsed={false}
            className="max-h-[60vh] overflow-y-auto"
          >
            <DesignCostHistory />
          </div>
        </aside>
      )}
    </div>
  );
};
