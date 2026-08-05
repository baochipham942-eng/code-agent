// ============================================================================
// usePinnedLibraryItems - 本会话 pin 的资料（数据侧）
// ============================================================================
//
// pin 闭环的数据一半：
// - 有 sessionId：getSessionPin 拉取（host 真源）+ libraryPinEvents 刷新
// - 无 sessionId（草稿/空间槽）：读 composerStore.pendingPinItemIds（意图，创建会话时物化）
// 渲染已并入文字流内联 chip（产品负责人 2026-08-05：pin 资料与文字同行）。
//

import { useCallback, useEffect, useState } from 'react';
import type { LibraryItem } from '@shared/contract/library';
import { getSessionPin, listLibraryItems, setSessionPin } from '../../../../services/libraryClient';
import { useComposerStore } from '../../../../stores/composerStore';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { LIBRARY_PIN_CHANGED_EVENT } from '../../knowledge/libraryPinEvents';

async function resolveItemsByIds(itemIds: string[]): Promise<LibraryItem[]> {
  if (itemIds.length === 0) return [];
  try {
    const all = await listLibraryItems();
    const byId = new Map(all.map((item) => [item.id, item]));
    return itemIds.map((id) => byId.get(id)).filter((item): item is LibraryItem => Boolean(item));
  } catch {
    return [];
  }
}

export function usePinnedLibraryItems(currentSessionId: string | null): {
  pinnedItems: LibraryItem[];
  removePin: (itemId: string) => void;
} {
  const { t } = useI18n();
  const pendingPinItemIds = useComposerStore((s) => s.pendingPinItemIds);
  const [pinnedItems, setPinnedItems] = useState<LibraryItem[]>([]);

  const loadSessionPins = useCallback(async (sessionId: string) => {
    try {
      const [pin, all] = await Promise.all([getSessionPin(sessionId), listLibraryItems()]);
      const byId = new Map(all.map((item) => [item.id, item]));
      // 只保留仍存在的条目；已被删的 pin id 静默跳过（host 端注入同样容错）
      setPinnedItems(pin.itemIds.map((id) => byId.get(id)).filter((item): item is LibraryItem => Boolean(item)));
    } catch {
      setPinnedItems([]);
    }
  }, []);

  useEffect(() => {
    if (currentSessionId) {
      void loadSessionPins(currentSessionId);
      const handleChanged = (event: Event) => {
        if ((event as CustomEvent<string>).detail === currentSessionId) {
          void loadSessionPins(currentSessionId);
        }
      };
      window.addEventListener(LIBRARY_PIN_CHANGED_EVENT, handleChanged);
      return () => window.removeEventListener(LIBRARY_PIN_CHANGED_EVENT, handleChanged);
    }

    // 草稿/空间：意图存在 composer 槽里
    let cancelled = false;
    void resolveItemsByIds(pendingPinItemIds).then((items) => {
      if (!cancelled) setPinnedItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, loadSessionPins, pendingPinItemIds]);

  const removePin = useCallback((itemId: string) => {
    if (currentSessionId) {
      setPinnedItems((prev) => {
        const next = prev.filter((item) => item.id !== itemId);
        setSessionPin(currentSessionId, next.map((item) => item.id)).catch(() => {
          setPinnedItems(prev);
          toast.error(t.library.pinFailed);
        });
        return next;
      });
      return;
    }
    useComposerStore.getState().togglePendingPinItemId(itemId);
  }, [currentSessionId, t]);

  return { pinnedItems, removePin };
}
