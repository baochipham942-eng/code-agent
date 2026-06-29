import React from 'react';
import { DesignCanvas } from './DesignCanvas';
import { useRestoreCanvasFromDisk } from './useRestoreCanvasFromDisk';

/**
 * 把 konva 设计画布作为「产物预览面」挂进专属 workbench tab（与全屏 DesignWorkspace 并存）。
 * 薄容器：给 DesignCanvas 一个 h-full w-full 的尺寸盒（Stage 需显式像素宽高，
 * 由 DesignCanvas 内部 ResizeObserver 跟随），并复用共享的画布磁盘恢复 hook。
 * 外层容器挂 data-testid="design-canvas-tab" 以与全屏覆盖层的 design-canvas 区分（M3）。
 */
export const DesignCanvasTab: React.FC = () => {
  // 画布恢复：runDir 已持久化但节点为空（刷新 / 独立挂载）→ 从磁盘 canvas.json 重载。
  useRestoreCanvasFromDisk();

  return (
    <div data-testid="design-canvas-tab" className="h-full w-full bg-zinc-950">
      <DesignCanvas />
    </div>
  );
};
