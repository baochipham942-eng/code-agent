// ============================================================================
// LibraryPanel - 资料库全屏页（2026-07-26 导航去重方案 9）
// ============================================================================
//
// 项目资产一等公民面，页头结构：来源 tab × 类型 chips × 搜索。
// - 顶行：来源 tab（AI 生成 / 我的上传 / 我的收藏）+ 右侧搜索框
//   + 「品牌套件」次级入口（原 section tab 降级为入口按钮，不再是并列分区）。
// - 次行：类型 chips = 全部 + LIBRARY_ITEM_KINDS（contract 推导，样式对齐原 kind filter）。
// 「记忆」tab 已撤（2026-07-27 审美关：记忆偏个人设置，不算资料库）——
// 家在设置 → 记忆（深链 openSettingsTab('memory')），独立整窗页 KnowledgeMemoryPanel 也仍在。
// 带进对话在聊天输入区做（@ 面板的资料库组 / PinnedLibraryChips），本页只管资产面。
// 布局契约（2026-07-27 UX 收尾 1.4）：内容区走 PageContent（全宽 + px-6 py-4），
// 两行工具带对齐同一横向节奏 px-6；
// 用 PageContent 的 flex 容器形态（scroll/padding 关闭），布局由被嵌组件自管。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Eye, FileText, Globe, Loader2, Package, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { LIBRARY_ITEM_KINDS, type LibraryItem, type LibraryItemKind } from '@shared/contract/library';
import type { Project } from '@shared/contract/project';
import { deleteLibraryItem, importLibraryFiles, listLibraryItems, setSessionPin, updateLibraryItem } from '../../../services/libraryClient';
import { listProjects } from '../../../services/projectClient';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { isPreviewable } from '../../../utils/previewable';
import { openExternalLink } from '../../../utils/platform';
import { matchesLibraryItemSearch, pruneLibrarySelection } from './libraryItemModel';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { PageContent } from '../shared/PageContent';
import { Button } from '../../primitives/Button';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { Textarea } from '../../primitives/Textarea';
import { BrandManager } from '../../design/BrandManager';

const GLOBAL_SCOPE = 'global';
const closeEmbeddedBrandManager = () => undefined;

// 页面视图：items = 条目列表；brands = 品牌套件管理（次级入口打开）。
// 「记忆」tab 已撤（2026-07-27 审美关：记忆是个人设置不是资料库）——它的家在
// 设置 → 记忆（SettingsModal 的 MemoryTab，深链 openSettingsTab('memory')），
// 独立整窗页 KnowledgeMemoryPanel 也仍在。一个能力只留一个家。
type LibraryView = 'items' | 'brands';

interface LibraryItemDraft {
  title: string;
  tags: string;
  summary: string;
}

function tagsToInput(tags: string[]): string {
  return tags.join(', ');
}

function parseTags(value: string): string[] {
  return value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
}

const KIND_ICONS: Record<LibraryItemKind, React.ReactNode> = {
  upload: <FileText className="h-3.5 w-3.5 text-sky-300" />,
  artifact: <Package className="h-3.5 w-3.5 text-emerald-300" />,
  capture: <BookOpen className="h-3.5 w-3.5 text-amber-300" />,
  external_ref: <Globe className="h-3.5 w-3.5 text-purple-300" />,
};

type LibraryGroup = {
  id: string;
  name: string;
  items: LibraryItem[];
};

export const LibraryPanel: React.FC = () => {
  const { t, language } = useI18n();
  const sessions = useSessionStore((s) => s.sessions);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [projects, setProjects] = useState<Project[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<LibraryItem | null>(null);
  const [draft, setDraft] = useState<LibraryItemDraft>({ title: '', tags: '', summary: '' });
  const [saving, setSaving] = useState(false);
  const [selectedKind, setSelectedKind] = useState<LibraryItemKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [updatedAtDescending, setUpdatedAtDescending] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [view, setView] = useState<LibraryView>('items');
  // 任务 16b：行勾选多选 → 底部浮条「带进新会话」
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bringing, setBringing] = useState(false);

  const projectId = scope === GLOBAL_SCOPE ? null : scope;
  const sessionTitles = useMemo(() => new Map<string, string>(
    sessions
      .map((session): [string, string] => [session.id, session.title.trim()])
      .filter(([, title]) => Boolean(title)),
  ), [sessions]);
  const kindLabels: Record<LibraryItemKind, string> = {
    upload: t.library.kindUpload,
    artifact: t.library.kindArtifact,
    capture: t.library.kindCapture,
    external_ref: t.library.kindExternalRef,
  };
  const groups = useMemo<LibraryGroup[]>(() => {
    const grouped = new Map<string, LibraryGroup>();
    const ungrouped: LibraryGroup = { id: 'ungrouped', name: t.library.ungrouped, items: [] };
    const visibleItems = items
      .filter((item) => selectedKind === 'all' || item.kind === selectedKind)
      .filter((item) => matchesLibraryItemSearch(item, search))
      .sort((left, right) => updatedAtDescending ? right.updatedAt - left.updatedAt : left.updatedAt - right.updatedAt);

    for (const item of visibleItems) {
      const sessionId = item.sourceSessionId;
      const title = sessionId ? sessionTitles.get(sessionId) : undefined;
      if (!sessionId || !title) {
        ungrouped.items.push(item);
        continue;
      }
      const existing = grouped.get(sessionId);
      if (existing) {
        existing.items.push(item);
      } else {
        grouped.set(sessionId, { id: sessionId, name: title, items: [item] });
      }
    }
    return [...grouped.values(), ...(ungrouped.items.length > 0 ? [ungrouped] : [])];
  }, [items, search, selectedKind, sessionTitles, t.library.ungrouped, updatedAtDescending]);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listLibraryItems({ projectId });
      setItems(list);
      // 刷新后剪掉已不存在的选中项，浮条计数不脱节
      setSelectedIds((current) => pruneLibrarySelection(current, list));
    } catch (error) {
      toast.error(t.library.loadFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const handleUpload = async (files: FileList) => {
    setUploading(true);
    try {
      const paths: string[] = [];
      for (const file of Array.from(files)) {
        const p = await ipcService.getPathForFile(file);
        if (p) paths.push(p);
      }
      if (paths.length === 0) throw new Error(t.library.importFailed);
      const result = await importLibraryFiles({ paths, projectId });
      if (result.items.length > 0) {
        toast.success(t.library.importedCount.replace('{count}', String(result.items.length)));
      }
      for (const err of result.errors) {
        toast.error(`${t.library.importFailed}: ${err.message}`);
      }
      await load();
    } catch (error) {
      toast.error(t.library.importFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (itemId: string) => {
    if (confirmingDelete !== itemId) {
      setConfirmingDelete(itemId);
      return;
    }
    setConfirmingDelete(null);
    try {
      await deleteLibraryItem(itemId);
      toast.success(t.library.deleted);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const openEdit = (item: LibraryItem) => {
    setEditingItem(item);
    setDraft({ title: item.title, tags: tagsToInput(item.tags), summary: item.summary ?? '' });
  };

  const closeEdit = () => {
    if (!saving) setEditingItem(null);
  };

  const handleSave = async () => {
    if (!editingItem || !draft.title.trim()) return;
    setSaving(true);
    try {
      const updatedItem = await updateLibraryItem(editingItem.id, {
        title: draft.title.trim(),
        tags: parseTags(draft.tags),
        summary: draft.summary,
      });
      setItems((currentItems) => currentItems.map((item) => (
        item.id === updatedItem.id ? updatedItem : item
      )));
      setEditingItem(null);
    } catch (error) {
      toast.error(t.library.editFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setSaving(false);
    }
  };

  // 任务 16a：行预览——复用 workbench PreviewPanel（openPreview）；
  // external_ref 走系统浏览器，非本地可预览路径优雅降级为 toast。
  const handlePreview = (item: LibraryItem) => {
    if (item.kind === 'external_ref') {
      if (!openExternalLink(item.pathOrUri)) {
        window.open(item.pathOrUri, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    if (!isPreviewable(item.pathOrUri)) {
      toast.error(t.library.previewUnavailable);
      return;
    }
    const app = useAppStore.getState();
    app.openPreview(item.pathOrUri);
    // 资料库页是 inline 二级页，会盖住 workbench——关掉它预览才看得见
    app.setShowLibraryPanel(false);
  };

  const toggleSelect = (itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  // 任务 16b：带进新会话——复用侧栏「新任务」同一条 createSession 路径
  // （非默认标题，跳过空白草稿复用），再把勾选条目 pin 进新会话；
  // createSession 会关掉本页并切到新会话，composer 上方 chip 区立即可见。
  const handleBringIntoNewSession = async () => {
    if (selectedIds.size === 0 || bringing) return;
    setBringing(true);
    try {
      const ids = [...selectedIds];
      const session = await useSessionStore.getState().createSession(
        t.library.bringSessionTitle.replace('{count}', String(ids.length)),
      );
      if (!session) throw new Error('createSession returned null');
      await setSessionPin(session.id, ids);
      setSelectedIds(new Set());
      toast.success(t.library.bringSuccess);
    } catch (error) {
      toast.error(t.library.bringFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setBringing(false);
    }
  };

  return (
    <FullScreenPage testId="library-panel" variant="inline">
      <FullScreenPageHeader
        icon={<BookOpen className="h-4 w-4 text-indigo-300" />}
        title={t.library.panelTitle}
        description={t.library.panelDescription}
        actions={view === 'items' ? (
          <div className="flex min-w-0 items-center gap-2">
            <select
              value={scope}
              onChange={(e) => { setScope(e.target.value); setSelectedIds(new Set()); }}
              data-testid="library-scope-select"
              className="h-8 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-300 outline-none focus:border-zinc-600"
            >
              <option value={GLOBAL_SCOPE}>{t.library.scopeGlobal}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void load()}
              disabled={loading}
              leftIcon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />}
            >
              {t.library.refresh}
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="library-upload"
              className="shrink-0 whitespace-nowrap"
              onClick={() => fileInputRef.current?.click()}
              loading={uploading}
              leftIcon={uploading ? undefined : <Upload className="h-3.5 w-3.5" />}
            >
              {uploading ? t.library.uploading : t.library.upload}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) void handleUpload(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        ) : undefined}
      />

      {/* 单行工具条（2026-07-27 产品负责人拍板：连着两行 tab 太复杂）：
          原「来源 tab」（AI 生成 / 我的上传 / 我的收藏）是类型 chips 的粗粒度重复
          —— AI 生成≈任务产物+采集内容、我的上传≈上传文件+外部引用，收藏那格更是
          contract 无字段的空壳 —— 整行删掉，只留类型 chips，搜索与品牌套件并入同一行右侧。 */}
      <div className="shrink-0 border-b border-zinc-800 px-6 py-2" data-testid="library-toolbar">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {view === 'items' && (
            <div className="flex flex-wrap items-center gap-1.5" aria-label={t.library.kindChipsLabel} data-testid="library-kind-chips">
              <Button
                type="button"
                size="sm"
                variant={selectedKind === 'all' ? 'secondary' : 'ghost'}
                aria-pressed={selectedKind === 'all'}
                data-testid="library-kind-chip-all"
                onClick={() => setSelectedKind('all')}
              >
                {t.library.allTypes}
              </Button>
              {LIBRARY_ITEM_KINDS.map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={selectedKind === kind ? 'secondary' : 'ghost'}
                  aria-pressed={selectedKind === kind}
                  data-testid={`library-kind-chip-${kind}`}
                  onClick={() => setSelectedKind(kind)}
                >
                  {kindLabels[kind]}
                </Button>
              ))}
            </div>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {view === 'items' && (
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t.library.searchPlaceholder}
                aria-label={t.library.searchPlaceholder}
                data-testid="library-search"
                className="h-8 w-40 min-w-0 text-xs"
              />
            )}
            {view === 'brands' ? (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 whitespace-nowrap"
                data-testid="library-brands-back"
                onClick={() => setView('items')}
              >
                {t.library.backToItems}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 whitespace-nowrap"
                data-testid="library-brands-entry"
                onClick={() => setView('brands')}
              >
                {t.library.brandKitsTab}
              </Button>
            )}
          </div>
        </div>
      </div>

      {view === 'items' ? (
        <PageContent id="library-items-panel" role="tabpanel">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-sm text-zinc-500 leading-relaxed">{t.library.empty}</div>
          ) : groups.length === 0 ? (
            <div className="py-16 text-center text-sm text-zinc-500 leading-relaxed">{t.library.empty}</div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-zinc-800" data-testid="library-item-list">
              <table className="w-full table-fixed text-left text-xs">
                <thead className="bg-zinc-900 text-zinc-500">
                  <tr>
                    <th className="w-8 px-2 py-2" />
                    <th className="w-[34%] px-3 py-2 font-medium">{t.library.nameColumn}</th>
                    <th className="w-[14%] px-3 py-2 font-medium">{t.library.typeColumn}</th>
                    <th className="w-[18%] px-3 py-2 font-medium">{t.library.sourceColumn}</th>
                    <th className="w-[16%] px-3 py-2 font-medium">
                      <button type="button" onClick={() => setUpdatedAtDescending((current) => !current)} className="hover:text-zinc-300" aria-label={t.library.sortByUpdatedAt}>
                        {t.library.updatedAtColumn}
                      </button>
                    </th>
                    <th className="w-[14%] px-3 py-2 font-medium">{t.library.actionsColumn}</th>
                  </tr>
                </thead>
                {groups.map((group) => {
                  const collapsed = collapsedGroups.has(group.id);
                  return (
                    <tbody key={group.id} data-testid={`library-group-${group.id}`}>
                      <tr className="border-y border-zinc-800 bg-zinc-900/70">
                        <th colSpan={6} className="px-3 py-2 text-left font-medium text-zinc-300">
                          <button type="button" onClick={() => toggleGroup(group.id)} className="inline-flex items-center gap-1.5 hover:text-white" aria-expanded={!collapsed}>
                            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            <span>{group.name}</span>
                            <span className="text-[11px] font-normal text-zinc-500">{t.library.groupCount.replace('{count}', String(group.items.length))}</span>
                          </button>
                        </th>
                      </tr>
                      {!collapsed && group.items.map((item) => (
                        <tr key={item.id} data-library-item={item.id} className={`group border-t border-zinc-800/80 hover:bg-zinc-800/50 ${selectedIds.has(item.id) ? 'bg-indigo-500/10' : 'bg-zinc-900/40'}`}>
                          <td className="px-2 py-2.5 align-top">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleSelect(item.id)}
                              aria-label={t.library.selectItemAria.replace('{title}', item.title)}
                              data-testid={`library-select-${item.id}`}
                              className="mt-1.5 h-3.5 w-3.5 cursor-pointer accent-indigo-500"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex min-w-0 items-start gap-2">
                              <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-zinc-800">{KIND_ICONS[item.kind]}</span>
                              <div className="min-w-0"><button /* ds-allow:button: 行标题即预览入口，纯文字热区，Button primitive 不适配 */ type="button" onClick={() => handlePreview(item)} title={t.library.preview} className="block max-w-full cursor-pointer truncate text-left text-sm text-zinc-200 hover:text-white hover:underline">{item.title}</button><div className="mt-0.5 truncate text-[11px] text-zinc-500">{item.summary || item.pathOrUri}</div><div className="mt-1 flex flex-wrap gap-1">{item.tags.map((tag) => <span key={tag} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{tag}</span>)}</div></div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-zinc-400">{kindLabels[item.kind]}</td>
                          <td className="truncate px-3 py-2.5 text-zinc-400">{item.sourceRoleId || t.library.sourceUpload}</td>
                          <td className="px-3 py-2.5 text-zinc-500">{new Date(item.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}</td>
                          <td className="px-3 py-2.5"><div className="flex items-center gap-1"><IconButton variant="ghost" size="sm" data-testid={`library-preview-${item.id}`} onClick={() => handlePreview(item)} title={t.library.preview} aria-label={t.library.preview} icon={<Eye className="h-3.5 w-3.5" />} /><IconButton variant="ghost" size="sm" data-testid={`library-edit-${item.id}`} onClick={() => openEdit(item)} title={t.library.edit} aria-label={t.library.edit} icon={<Pencil className="h-3.5 w-3.5" />} /><IconButton variant="danger" size="sm" data-testid={`library-delete-${item.id}`} onClick={() => void handleDelete(item.id)} className={confirmingDelete === item.id ? 'bg-red-500/20 text-red-300' : ''} title={confirmingDelete === item.id ? t.library.deleteConfirm : t.library.deleteAction} aria-label={confirmingDelete === item.id ? t.library.deleteConfirm : t.library.deleteAction} icon={<Trash2 className="h-3.5 w-3.5" />} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )}
        </PageContent>
      ) : (
        <PageContent id="library-brands-panel" role="tabpanel">
          <BrandManager isOpen onClose={closeEmbeddedBrandManager} presentation="inline" />
        </PageContent>
      )}

      {/* 任务 16b：多选浮条——参考 WorkBuddy「我的文件」底部浮条，
          主按钮把勾选条目 pin 进一个新会话 */}
      {view === 'items' && selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2" data-testid="library-selection-bar">
          <div className="flex items-center gap-3 rounded-full border border-zinc-700 bg-zinc-900/95 px-4 py-2 shadow-xl">
            <span className="whitespace-nowrap text-xs text-zinc-300">
              {t.library.selectedCount.replace('{count}', String(selectedIds.size))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              onClick={() => setSelectedIds(new Set())}
              leftIcon={<X className="h-3.5 w-3.5" />}
            >
              {t.library.clearSelection}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              data-testid="library-bring-into-session"
              onClick={() => void handleBringIntoNewSession()}
              loading={bringing}
            >
              {t.library.bringIntoNewSession}
            </Button>
          </div>
        </div>
      )}

      <Modal
        isOpen={editingItem !== null}
        onClose={closeEdit}
        title={t.library.editTitle}
        size="md"
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeEdit} disabled={saving}>{t.common.cancel}</Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={!draft.title.trim() || saving}
              loading={saving}
              data-testid="library-edit-save"
            >
              {t.library.save}
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <label className="block space-y-1.5 text-sm text-zinc-300" htmlFor="library-edit-title">
            <span>{t.library.titleLabel}</span>
            <Input
              id="library-edit-title"
              data-testid="library-edit-title"
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              disabled={saving}
              required
            />
          </label>
          <label className="block space-y-1.5 text-sm text-zinc-300" htmlFor="library-edit-tags">
            <span>{t.library.tagsLabel}</span>
            <Input
              id="library-edit-tags"
              data-testid="library-edit-tags"
              value={draft.tags}
              onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
              placeholder={t.library.tagsHint}
              disabled={saving}
            />
          </label>
          <label className="block space-y-1.5 text-sm text-zinc-300" htmlFor="library-edit-summary">
            <span>{t.library.summaryLabel}</span>
            <Textarea
              id="library-edit-summary"
              data-testid="library-edit-summary"
              value={draft.summary}
              onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
              disabled={saving}
              minRows={3}
            />
          </label>
        </div>
      </Modal>
    </FullScreenPage>
  );
};
