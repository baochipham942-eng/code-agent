import React, { useEffect } from 'react';
import { DesignCanvas } from './DesignCanvas';
import { useDesignCanvasStore } from './designCanvasStore';
import { loadCanvasDoc } from './designCanvasPersistence';

/**
 * 把 konva 设计画布作为「产物预览面」挂进专属 workbench tab（与全屏 DesignWorkspace 并存）。
 * 薄容器：给 DesignCanvas 一个 h-full w-full 的尺寸盒（Stage 需显式像素宽高，
 * 由 DesignCanvas 内部 ResizeObserver 跟随），并复刻 DesignWorkspace 的画布恢复 effect。
 */
export const DesignCanvasTab: React.FC = () => {
  // 画布恢复：runDir 已持久化但节点为空（刷新 / 独立挂载）→ 从磁盘 canvas.json 重载。
  // 逐字复刻 DesignWorkspace 的恢复逻辑，让画布在 tab 内独立挂载时也能从磁盘恢复。
  useEffect(() => {
    const cs = useDesignCanvasStore.getState();
    if (!cs.runDir || cs.nodes.length > 0) return;
    const runDir = cs.runDir;
    void loadCanvasDoc(runDir).then((doc) => {
      const cur = useDesignCanvasStore.getState();
      if (cur.runDir === runDir && cur.nodes.length === 0) {
        cur.loadDoc(runDir, doc);
      }
    });
  }, []);

  return (
    <div className="h-full w-full bg-zinc-950">
      <DesignCanvas />
    </div>
  );
};
