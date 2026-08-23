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
import type { ProjectArtifact } from '@shared/contract/project';
import type { Session } from '@shared/contract/session';
import { getSessionPin, listLibraryItems, setSessionPin } from '../../../../services/libraryClient';
import { getProjectArtifacts, listProjects } from '../../../../services/projectClient';
import { useComposerStore } from '../../../../stores/composerStore';
import { notifyLibraryPinChanged } from '../../knowledge/libraryPinEvents';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { isImeKeyEvent, useImeCompositionRef } from './imeCompositionGuard';
import {
  buildArtifactRows,
  buildFileRows,
  buildLibraryRows,
  buildSessionRows,
  flattenAtMentionRows,
  groupLimitForTab,
  shiftAtMentionTab,
  wrapIndex,
  type AtMentionArtifactRow,
  type AtMentionFileMatch,
  type AtMentionFileRow,
  type AtMentionLibraryRow,
  type AtMentionRow,
  type AtMentionSessionRow,
  type AtMentionTab,
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
  /**
   * 有会话：pin 读写 host getSessionPin/setSessionPin。
   * 无会话（草稿/空间槽）：pin 意图写 composerStore.pendingPinItemIds，创建会话时物化。
   */
  sessionId: string | null;
  /** 当前项目（pin 候选口径：本项目 ∪ 全局架）；空间页由 scopeProjectId 传入。 */
  projectId: string | null;
  /** 文件行选中后的插入动作（组件持有：文件 → 内联 chip + 附件；目录 → 保留 @path 文本）。 */
  onFileSelect: (row: AtMentionFileRow) => void;
  onSessionSelect: (row: AtMentionSessionRow) => void;
  onArtifactSelect: (row: AtMentionArtifactRow) => void;
}

export function useAtMentionPanel(params: UseAtMentionPanelParams) {
  const { sessionId, projectId, onFileSelect, onSessionSelect, onArtifactSelect } = params;
  const { t } = useI18n();
  const isComposingRef = useImeCompositionRef();
  const pendingPinItemIds = useComposerStore((s) => s.pendingPinItemIds);

  const [files, setFiles] = useState<AtMentionFileMatch[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [sessions, setSessions] = useState<Array<Session & { messageCount?: number }>>([]);
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [sessionPinnedIds, setSessionPinnedIds] = useState<ReadonlySet<string>>(new Set());
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<AtMentionTab>('all');
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
  const onSessionSelectRef = useRef(onSessionSelect);
  onSessionSelectRef.current = onSessionSelect;
  const onArtifactSelectRef = useRef(onArtifactSelect);
  onArtifactSelectRef.current = onArtifactSelect;

  const pinnedIds = useMemo(
    () => (sessionId ? sessionPinnedIds : new Set(pendingPinItemIds)),
    [sessionId, sessionPinnedIds, pendingPinItemIds],
  );

  const refreshLibrary = useCallback(async (targetSessionId: string | null) => {
    try {
      if (targetSessionId) {
        const [all, pin] = await Promise.all([listLibraryItems(), getSessionPin(targetSessionId)]);
        setLibraryItems(all);
        setSessionPinnedIds(new Set(pin.itemIds));
      } else {
        const all = await listLibraryItems();
        setLibraryItems(all);
        // 草稿/空间 pin 意图由 composerStore.pendingPinItemIds 驱动，不在这里覆写
      }
    } catch {
      // 资料库不可用时静默降级为纯文件面板（与旧行为一致）
      setLibraryItems([]);
      if (targetSessionId) setSessionPinnedIds(new Set());
    }
  }, []);

  const refreshReferences = useCallback(async (targetProjectId: string | null) => {
    const [sessionsResult, projectsResult, artifactsResult] = await Promise.allSettled([
      window.domainAPI?.invoke<Array<Session & { messageCount?: number }>>(
        IPC_DOMAINS.SESSION,
        'list',
        { includeArchived: true, limit: 50 },
      ),
      listProjects(true),
      targetProjectId ? getProjectArtifacts(targetProjectId, 50) : Promise.resolve([]),
    ]);
    setSessions(
      sessionsResult.status === 'fulfilled' && sessionsResult.value?.success
        ? sessionsResult.value.data ?? []
        : [],
    );
    setProjectNames(new Map(
      projectsResult.status === 'fulfilled'
        ? projectsResult.value.map((project) => [project.id, project.name])
        : [],
    ));
    setArtifacts(artifactsResult.status === 'fulfilled' ? artifactsResult.value : []);
  }, []);

  // 换会话后 pin 是真源在会话上的，重拉一次避免拿上个会话的选中态
  useEffect(() => {
    setLibraryItems([]);
    setSessionPinnedIds(new Set());
    if (wasOpenRef.current) {
      void refreshLibrary(sessionId);
      void refreshReferences(projectId);
    }
  }, [projectId, refreshLibrary, refreshReferences, sessionId]);

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
    // 草稿/空间同样拉库，pin 意图挂 composer 槽
    if (!wasOpenRef.current) {
      void refreshLibrary(sessionId);
      void refreshReferences(projectId);
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const entries = await listWorkspaceFiles(searchQuery || '.');
        setFiles(entries);
        setIsOpen(true);
        wasOpenRef.current = true;
      } catch {
        setFiles([]);
        setIsOpen(true);
        wasOpenRef.current = true;
      }
    }, 200);
  }, [projectId, refreshLibrary, refreshReferences, sessionId]);

  const dismiss = useCallback((untilTextChange = false) => {
    clearTimeout(debounceRef.current);
    if (untilTextChange) dismissedTextRef.current = lastTextRef.current;
    setIsOpen(false);
    wasOpenRef.current = false;
  }, []);

  const togglePin = useCallback((itemId: string) => {
    if (!sessionId) {
      useComposerStore.getState().togglePendingPinItemId(itemId);
      return;
    }
    const prev = sessionPinnedIds;
    const next = new Set(prev);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    setSessionPinnedIds(next);
    notifyLibraryPinChanged(sessionId);
    setSessionPin(sessionId, [...next]).catch(() => {
      setSessionPinnedIds(prev);
      notifyLibraryPinChanged(sessionId);
      toast.error(t.library.pinFailed);
    });
  }, [sessionPinnedIds, sessionId, t]);

  const groupLimit = groupLimitForTab(activeTab);
  const libraryRows = useMemo(
    () => activeTab === 'all' || activeTab === 'library'
      ? buildLibraryRows(libraryItems, projectId, pinnedIds, query, groupLimit)
      : [],
    [activeTab, groupLimit, libraryItems, projectId, pinnedIds, query],
  );
  const fileRows = useMemo(
    () => activeTab === 'all' || activeTab === 'files' ? buildFileRows(files, query, groupLimit) : [],
    [activeTab, files, groupLimit, query],
  );
  const sessionRows = useMemo(
    () => activeTab === 'all' || activeTab === 'sessions'
      ? buildSessionRows(sessions, projectNames, query, sessionId, groupLimit)
      : [],
    [activeTab, groupLimit, projectNames, query, sessionId, sessions],
  );
  const artifactRows = useMemo(
    () => activeTab === 'all' || activeTab === 'artifacts' ? buildArtifactRows(artifacts, query, groupLimit) : [],
    [activeTab, artifacts, groupLimit, query],
  );
  const flatRows = useMemo(
    () => flattenAtMentionRows(libraryRows, fileRows, sessionRows, artifactRows),
    [artifactRows, fileRows, libraryRows, sessionRows],
  );

  // query / 结果集变化后高亮回第一行（与 SlashCommandPopover 的 filter 复位一致）
  useEffect(() => {
    setSelectedIndex(0);
  }, [activeTab, query, flatRows.length]);

  const selectRow = useCallback((row: AtMentionRow) => {
    if (row.kind === 'file') {
      onFileSelectRef.current(row);
      dismiss();
      return;
    }
    if (row.kind === 'session') {
      onSessionSelectRef.current(row);
      dismiss();
      return;
    }
    if (row.kind === 'artifact') {
      onArtifactSelectRef.current(row);
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
    if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setActiveTab((tab) => shiftAtMentionTab(tab, e.key === 'ArrowRight' ? 1 : -1));
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
    activeTab,
    setActiveTab,
    libraryRows,
    fileRows,
    sessionRows,
    artifactRows,
    flatRows,
    selectedIndex,
    setSelectedIndex,
    search,
    dismiss,
    selectRow,
    handleKeyDown,
  };
}

export type { AtMentionArtifactRow, AtMentionFileRow, AtMentionLibraryRow, AtMentionRow, AtMentionSessionRow, AtMentionTab };
