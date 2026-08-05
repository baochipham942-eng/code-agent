// ============================================================================
// usePinnedLibraryItems - 本会话 pin 的资料（数据侧）
// ============================================================================
//
// pin 闭环的数据一半：会话加载/切换时 getSessionPin 拉取；监听 libraryPinEvents
// （@ 面板资料库组勾选/取消后即时刷新）。渲染已并入文字流内联 chip
// （产品负责人 2026-08-05：pin 资料与文字同行，不再独立一行；此前的
// PinnedLibraryChips 顶排组件随之退役），删除走 InlineComposerChip 统一交互，
// removePin 乐观更新失败回滚。

import { useCallback, useEffect, useState } from 'react';
import type { LibraryItem } from '@shared/contract/library';
import { getSessionPin, listLibraryItems, setSessionPin } from '../../../../services/libraryClient';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { LIBRARY_PIN_CHANGED_EVENT } from '../../knowledge/libraryPinEvents';

export function usePinnedLibraryItems(currentSessionId: string | null): {
  pinnedItems: LibraryItem[];
  removePin: (itemId: string) => void;
} {
  const { t } = useI18n();
  const [pinnedItems, setPinnedItems] = useState<LibraryItem[]>([]);

  const load = useCallback(async (sessionId: string) => {
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
    if (!currentSessionId) {
      setPinnedItems([]);
      return;
    }
    void load(currentSessionId);
    const handleChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail === currentSessionId) void load(currentSessionId);
    };
    window.addEventListener(LIBRARY_PIN_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(LIBRARY_PIN_CHANGED_EVENT, handleChanged);
  }, [currentSessionId, load]);

  const removePin = useCallback((itemId: string) => {
    if (!currentSessionId) return;
    setPinnedItems((prev) => {
      const next = prev.filter((item) => item.id !== itemId);
      setSessionPin(currentSessionId, next.map((item) => item.id)).catch(() => {
        setPinnedItems(prev);
        toast.error(t.library.pinFailed);
      });
      return next;
    });
  }, [currentSessionId, t]);

  return { pinnedItems, removePin };
}
