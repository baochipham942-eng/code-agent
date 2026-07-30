// ============================================================================
// useAtMentionPanel - @ 触发面板（WorkBuddy 形态）的数据与键盘导航
// ============================================================================
//
// 2026-07-29 UX round2 任务 14：替代旧 useFileAutocomplete（hooks/ 下已删）。
// - 触发规则不变：光标前文本尾部匹配 /@([^\s@]*)$/，200ms 防抖拉工作区文件。
// - 面板打开时（每次 false→true）拉资料库条目 + 本会话 pin，客户端过滤
//   （filterPinCandidates / matchesLibraryItemSearch），行选中 = 切换 pin。
// - 键盘导航（↑↓ 跨组循环 / Enter 选中 / Esc 关闭）经 onAutocompleteKeyDown
//   接进 InputArea，Enter 用 imeCompositionGuard 防中文输入法上屏误选。
// pin 写库乐观更新、失败回滚，并广播 libraryPinEvents 让 PinnedLibraryChips 即时刷新。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { LibraryItem } from '@shared/contract/library';
import { getSessionPin, listLibraryItems, setSessionPin } from '../../../../services/libraryClient';
import { notifyLibraryPinChanged } from '../../knowledge/libraryPinEvents';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { isImeKeyEvent, useImeCompositionRef } from './imeCompositionGuard';
import {
  buildFileRows,
  buildLibraryRows,
  flattenAtMentionRows,
  wrapIndex,
  type AtMentionFileMatch,
  type AtMentionFileRow,
  type AtMentionLibraryRow,
  type AtMentionRow,
} from './atMentionPanelModel';

const AT_TRIGGER_RE = /@([^\s@]*)$/;

async function listWorkspaceFiles(dirPath: string): Promise<AtMentionFileMatch[]> {
  const response = await window.domainAPI?.invoke<Array<{ name: string; path?: string; isDirectory?: boolean }>>(
    IPC_DOMAINS.WORKSPACE,
    'listFiles',
    { dirPath },
  );
  if (!response?.success) {
    throw new Error(response?.error?.message || 'Failed to list workspace files');
  }
  return (response.data ?? []).map((entry) => ({
    path: entry.path || entry.name,
    name: entry.name,
    isDirectory: Boolean(entry.isDirectory),
  }));
}

export interface UseAtMentionPanelParams {
  /** pin 读写需要会话；无会话时资料库组不展示（pin 无从挂起）。 */
  sessionId: string | null;
  /** 当前会话所属项目（pin 候选口径：本项目 ∪ 全局架）。 */
  projectId: string | null;
  /** 文件行选中后的插入动作（组件持有：文件 → 内联 chip + 附件；目录 → 保留 @path 文本）。 */
  onFileSelect: (row: AtMentionFileRow) => void;
}

export function useAtMentionPanel(params: UseAtMentionPanelParams) {
  const { sessionId, projectId, onFileSelect } = params;
  const { t } = useI18n();
  const isComposingRef = useImeCompositionRef();

  const [files, setFiles] = useState<AtMentionFileMatch[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(new Set());
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Esc 关闭后记录当前文本：文本不变就不因下一次 search 调用把面板弹回来
  // （与 agent mention 的 dismissedAgentAutocompleteValue 同一思路）。
  const dismissedTextRef = useRef<string | null>(null);
  const lastTextRef = useRef('');
  const wasOpenRef = useRef(false);
  // onFileSelect 依赖组件的 value/query，每次按键都变；经 ref 调最新版，避免 hook 内回调链全跟着重建。
  const onFileSelectRef = useRef(onFileSelect);
  onFileSelectRef.current = onFileSelect;

  const refreshLibrary = useCallback(async (targetSessionId: string) => {
    try {
      const [all, pin] = await Promise.all([listLibraryItems(), getSessionPin(targetSessionId)]);
      setLibraryItems(all);
      setPinnedIds(new Set(pin.itemIds));
    } catch {
      // 资料库不可用时静默降级为纯文件面板（与旧行为一致）
      setLibraryItems([]);
      setPinnedIds(new Set());
    }
  }, []);

  // 换会话后 pin 是真源在会话上的，重拉一次避免拿上个会话的选中态
  useEffect(() => {
    setLibraryItems([]);
    setPinnedIds(new Set());
    if (sessionId && wasOpenRef.current) void refreshLibrary(sessionId);
  }, [sessionId, refreshLibrary]);

  const search = useCallback((text: string, cursorPos: number) => {
    // 先取消上一次挂起的防抖请求，否则清空输入后它仍会回调 setIsOpen(true) 把 popup 弹回来。
    clearTimeout(debounceRef.current);
    lastTextRef.current = text;

    const beforeCursor = text.slice(0, cursorPos);
    const atMatch = beforeCursor.match(AT_TRIGGER_RE);

    if (!atMatch) {
      setIsOpen(false);
      setFiles([]);
      dismissedTextRef.current = null;
      return;
    }

    if (dismissedTextRef.current === text) {
      setIsOpen(false);
      return;
    }

    const searchQuery = atMatch[1];
    setQuery(searchQuery);

    // 面板 false→true：拉/刷新资料库条目与 pin（pin 可能被 chips 行 × 掉过）
    if (sessionId && !wasOpenRef.current) void refreshLibrary(sessionId);

    debounceRef.current = setTimeout(async () => {
      try {
        const entries = await listWorkspaceFiles(searchQuery || '.');
        setFiles(entries);
        setIsOpen(true);
        wasOpenRef.current = true;
      } catch {
        setIsOpen(false);
        wasOpenRef.current = false;
      }
    }, 200);
  }, [refreshLibrary, sessionId]);

  const dismiss = useCallback((untilTextChange = false) => {
    clearTimeout(debounceRef.current);
    if (untilTextChange) dismissedTextRef.current = lastTextRef.current;
    setIsOpen(false);
    wasOpenRef.current = false;
  }, []);

  const togglePin = useCallback((itemId: string) => {
    if (!sessionId) return;
    const prev = pinnedIds;
    const next = new Set(prev);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    setPinnedIds(next);
    notifyLibraryPinChanged(sessionId);
    setSessionPin(sessionId, [...next]).catch(() => {
      setPinnedIds(prev);
      notifyLibraryPinChanged(sessionId);
      toast.error(t.library.pinFailed);
    });
  }, [pinnedIds, sessionId, t]);

  const libraryRows = useMemo(
    () => (sessionId ? buildLibraryRows(libraryItems, projectId, pinnedIds, query) : []),
    [sessionId, libraryItems, projectId, pinnedIds, query],
  );
  const fileRows = useMemo(() => buildFileRows(files, query), [files, query]);
  const flatRows = useMemo(() => flattenAtMentionRows(libraryRows, fileRows), [libraryRows, fileRows]);

  // query / 结果集变化后高亮回第一行（与 SlashCommandPopover 的 filter 复位一致）
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, flatRows.length]);

  const selectRow = useCallback((row: AtMentionRow) => {
    if (row.kind === 'file') {
      onFileSelectRef.current(row);
      dismiss();
      return;
    }
    // 资料库行 = 切换 pin，面板保持打开，一次可以带多条资料进会话
    togglePin(row.item.id);
  }, [dismiss, togglePin]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>): boolean => {
    if (!isOpen) return false;

    if (e.key === 'ArrowDown' && flatRows.length > 0) {
      e.preventDefault();
      setSelectedIndex((prev) => wrapIndex(prev, 1, flatRows.length));
      return true;
    }
    if (e.key === 'ArrowUp' && flatRows.length > 0) {
      e.preventDefault();
      setSelectedIndex((prev) => wrapIndex(prev, -1, flatRows.length));
      return true;
    }
    // IME 组合中的 Enter 是确认候选词（如中文选字），不能当成选择面板项
    if (e.key === 'Enter' && !e.shiftKey && !isImeKeyEvent(e.nativeEvent, isComposingRef)) {
      const selected = flatRows[Math.min(selectedIndex, flatRows.length - 1)];
      if (selected) {
        e.preventDefault();
        selectRow(selected);
        return true;
      }
      return false;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss(true);
      return true;
    }
    return false;
  }, [dismiss, flatRows, isComposingRef, isOpen, selectRow, selectedIndex]);

  return {
    isOpen,
    query,
    libraryRows,
    fileRows,
    flatRows,
    selectedIndex,
    setSelectedIndex,
    search,
    dismiss,
    selectRow,
    handleKeyDown,
  };
}

export type { AtMentionFileRow, AtMentionLibraryRow, AtMentionRow };
