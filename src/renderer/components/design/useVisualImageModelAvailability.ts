// 视觉图模型 key 可用性（listVisualImageModels IPC）。2026-08-01 审美关返工#4：
// 标注重绘的默认模型必须选「当前可用（已配 key）」的——旧逻辑默认取首个 annotEdit 模型，
// 可能是没配 key 的 GPT-image-2，用户点批注重绘直接失败。可用性提升到 DesignCanvas 层
// （算 effectiveAnnotModel + 无可用降级都要用），AnnotModelSelect 改为纯展示接收 prop。
import { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';

/**
 * null = 尚未回包（加载中，按旧行为处理、不降级）；map[id] = 该模型已配 key 可用。
 */
export function useVisualImageModelAvailability(): Record<string, boolean> | null {
  const [availability, setAvailability] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.domainAPI?.invoke<{ models: Array<{ id: string; available: boolean }> }>(
        IPC_DOMAINS.WORKSPACE,
        'listVisualImageModels',
      );
      if (!cancelled && res?.success && res.data?.models) {
        const map: Record<string, boolean> = {};
        for (const m of res.data.models) map[m.id] = m.available;
        setAvailability(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return availability;
}
