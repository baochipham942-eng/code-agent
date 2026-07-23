import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { IconButton } from '../primitives';
import { DesignCanvas } from './DesignCanvas';
import { DesignCostHistory } from './DesignCostHistory';
import { useRestoreCanvasFromDisk } from './useRestoreCanvasFromDisk';

/**
 * 把 konva 设计画布作为「产物预览面」挂进专属 workbench tab。
 * 薄容器：给 DesignCanvas 一个 h-full w-full 的尺寸盒（Stage 需显式像素宽高，
 * 由 DesignCanvas 内部 ResizeObserver 跟随），并复用共享的画布磁盘恢复 hook。
 * 外层容器挂 data-testid="design-canvas-tab" 供交互测试定位。
 */
export const DesignCanvasTab: React.FC = () => {
  const { t } = useI18n();
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // 画布恢复：runDir 已持久化但节点为空（刷新 / 独立挂载）→ 从磁盘 canvas.json 重载。
  useRestoreCanvasFromDisk();

  return (
    <div data-testid="design-canvas-tab" className="relative h-full w-full bg-zinc-950">
      <DesignCanvas showErrorBar />
      <aside
        data-testid="design-cost-history-dock"
        className="pointer-events-none absolute bottom-4 right-4 z-20 flex w-80 max-w-[calc(100%_-_2rem)] flex-col items-end gap-1"
      >
        <IconButton
          type="button"
          variant="outline"
          size="sm"
          aria-label={historyExpanded ? t.design.historyCollapse : t.design.historyExpand}
          aria-expanded={historyExpanded}
          aria-controls="design-cost-history-content"
          onClick={() => setHistoryExpanded((expanded) => !expanded)}
          icon={
            <ChevronDown
              className={`h-full w-full transition-transform ${historyExpanded ? '' : 'rotate-180'}`}
            />
          }
          className="pointer-events-auto bg-zinc-950/85 shadow-lg backdrop-blur"
        />
        <div
          id="design-cost-history-content"
          data-testid="design-cost-history-content"
          data-collapsed={!historyExpanded}
          className={`pointer-events-auto w-full ${historyExpanded ? 'max-h-[60vh] overflow-y-auto' : ''}`}
        >
          <DesignCostHistory collapsed={!historyExpanded} />
        </div>
      </aside>
    </div>
  );
};
