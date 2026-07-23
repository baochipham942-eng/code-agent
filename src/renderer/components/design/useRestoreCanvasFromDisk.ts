import { useEffect } from 'react';
import { useDesignCanvasStore } from './designCanvasStore';
import { loadCanvasDoc } from './designCanvasPersistence';

/**
 * 画布磁盘恢复：runDir 已持久化但节点为空（刷新 / 独立挂载）→ 从磁盘 canvas.json 重载。
 * DesignCanvasTab 挂载时从磁盘恢复画布，切 run 前清空旧内容以免串图。
 */
export function useRestoreCanvasFromDisk(): void {
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
}
