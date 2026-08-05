// ============================================================================
// PinnedLibraryChips - composer 上方「本会话 pin 的资料」chip 区（2026-07-29 任务 9a）
// ============================================================================
//
// pin 闭环的可见一半：会话加载/切换时 getSessionPin 拉取，渲染 chip（Pin 图标+标题）。
// 删除交互与文件/capability chip 统一（2026-07-29 任务 10）：hover 浮现 × 按钮删除，
// 或 chip 聚焦后按 Delete/Backspace；移除即 setSessionPin 写回，乐观更新失败回滚。
// 无 pin 时不渲染。监听 libraryPinEvents：@ 面板资料库组勾选/取消后这里即时刷新。
// 样式对齐 SelectedCapabilityChips。

import { useCallback, useEffect, useState } from 'react';
import { Pin, X } from 'lucide-react';
import type { LibraryItem } from '@shared/contract/library';
import { getSessionPin, listLibraryItems, setSessionPin } from '../../../../services/libraryClient';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { LIBRARY_PIN_CHANGED_EVENT } from '../../knowledge/libraryPinEvents';

export function PinnedLibraryChips() {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const [pinnedItems, setPinnedItems] = useState<LibraryItem[]>([]);

  const load = useCallback(async (sessionId: string) => {
    try {
      const [pin, all] = await Promise.all([getSessionPin(sessionId), listLibraryItems()]);
      const byId = new Map(all.map((item) => [item.id, item]));
      // 只展示仍存在的条目；已被删的 pin id 静默跳过（host 端注入同样容错）
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

  const removePin = (itemId: string) => {
    if (!currentSessionId) return;
    const prev = pinnedItems;
    const next = prev.filter((item) => item.id !== itemId);
    setPinnedItems(next);
    setSessionPin(currentSessionId, next.map((item) => item.id)).catch(() => {
      setPinnedItems(prev);
      toast.error(t.library.pinFailed);
    });
  };

  if (!currentSessionId || pinnedItems.length === 0) return null;

  return (
    <div className="mt-3 mb-2 flex flex-wrap items-center gap-1.5 px-2" data-testid="pinned-library-chips">
      {pinnedItems.map((item) => (
        // 删除交互与文件/capability chip 对齐（2026-07-29）：整颗点击不再删除，
        // 收敛到 hover 浮现的 × 按钮 + chip 聚焦后 Delete/Backspace。
        <div
          key={item.id}
          role="group"
          tabIndex={0}
          title={item.summary || item.pathOrUri}
          aria-label={item.title}
          onKeyDown={(event) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            event.preventDefault();
            removePin(item.id);
          }}
          className="group inline-flex max-w-[220px] cursor-default items-center gap-1 rounded-full border border-badge-accent/30 bg-indigo-500/10 px-1.5 py-0.5 text-xs text-badge-accent transition-colors hover:border-badge-accent/50"
        >
          <Pin className="h-4 w-4 shrink-0 p-0.5" aria-hidden />
          <span className="truncate">{item.title}</span>
          <button /* ds-allow:button: chip 删除是图标级小按钮，Button primitive 无此紧凑图标变体 */
            type="button"
            tabIndex={-1}
            onClick={() => removePin(item.id)}
            aria-label={t.library.pinnedChipRemoveAria.replace('{title}', item.title)}
            className="-mr-0.5 shrink-0 rounded-full p-0.5 text-badge-accent opacity-0 transition-opacity hover:bg-indigo-400/20 hover:text-badge-accent focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
