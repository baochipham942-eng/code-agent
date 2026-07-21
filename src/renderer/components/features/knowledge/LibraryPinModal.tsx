// ============================================================================
// LibraryPinModal - 会话内资料库 Pin 选择器（Batch 2 L2）
// ============================================================================
//
// 列出当前项目 + 全局架的资料条目，勾选即 pin 进本会话上下文（索引注入，
// 正文按需 Read）。选中即保存（乐观更新，失败回滚）。

import React, { useEffect, useState } from 'react';
import { BookOpen, Loader2, Pin } from 'lucide-react';
import type { LibraryItem } from '@shared/contract/library';
import { getSessionPin, listLibraryItems, setSessionPin } from '../../../services/libraryClient';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { Modal } from '../../primitives/Modal';

interface Props {
  sessionId: string;
  projectId: string | null;
  onClose: () => void;
}

export const LibraryPinModal: React.FC<Props> = ({ sessionId, projectId, onClose }) => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [pinned, setPinned] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [all, pin] = await Promise.all([listLibraryItems(), getSessionPin(sessionId)]);
        if (cancelled) return;
        // 边界可见：只展示本项目 + 全局架，其他项目的条目不进本会话候选
        setItems(all.filter((item) => item.projectId === projectId || item.projectId === null));
        setPinned(new Set(pin.itemIds));
      } catch (error) {
        if (!cancelled) {
          toast.error(t.library.loadFailed + (error instanceof Error ? `: ${error.message}` : ''));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, projectId, t]);

  const toggle = (itemId: string) => {
    const prev = pinned;
    const next = new Set(prev);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    setPinned(next);
    setSessionPin(sessionId, [...next]).catch(() => {
      setPinned(prev);
      toast.error(t.library.pinFailed);
    });
  };

  const projectItems = items.filter((item) => item.projectId !== null);
  const globalItems = items.filter((item) => item.projectId === null);

  const renderGroup = (label: string, groupItems: LibraryItem[]) => {
    if (groupItems.length === 0) return null;
    return (
      <div key={label}>
        <div className="px-1 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
        {groupItems.map((item) => (
          <button /* ds-allow:button: pin 选择列表行（图标+两行文本+选中态整行高亮），Button primitive 是居中动作按钮形状，变体不适配列表行 */
            key={item.id}
            type="button"
            data-library-pin-item={item.id}
            onClick={() => toggle(item.id)}
            className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
              pinned.has(item.id) ? 'bg-indigo-500/15 hover:bg-indigo-500/20' : 'hover:bg-zinc-700/50'
            }`}
          >
            <Pin className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${pinned.has(item.id) ? 'text-indigo-300' : 'text-zinc-600'}`} />
            <span className="min-w-0">
              <span className="block text-xs text-zinc-200 truncate">{item.title}</span>
              <span className="block text-[10px] text-zinc-500 truncate">
                {item.summary || item.pathOrUri}
                {item.tags.length > 0 && ` · ${item.tags.join(' / ')}`}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t.library.pinModalTitle}
      headerIcon={<BookOpen className="w-4 h-4 text-indigo-300" />}
      size="md"
      footer={(
        <div className="text-[11px] text-zinc-500">
          {t.library.pinnedCount.replace('{count}', String(pinned.size))}
        </div>
      )}
    >
      <div data-library-pin-modal className="flex flex-col max-h-[55vh]">
        <div className="px-1 pb-2 text-[11px] text-zinc-500 leading-relaxed">{t.library.pinModalHint}</div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-zinc-500 leading-relaxed">{t.library.empty}</div>
          ) : (
            <>
              {renderGroup(t.library.projectGroup, projectItems)}
              {renderGroup(t.library.globalGroup, globalItems)}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
