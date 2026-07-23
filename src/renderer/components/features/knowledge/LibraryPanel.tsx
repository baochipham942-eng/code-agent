// ============================================================================
// LibraryPanel - 资料库全屏页（Batch 2 L3）
// ============================================================================
//
// 项目资产一等公民面：按作用域（全局/项目）列条目，上传文件入库，删除条目。
// 带进对话在聊天输入区的 LibraryPinModal 里做，本页只管资产面。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FileText, Globe, Loader2, Package, Pencil, RefreshCw, Trash2, Upload } from 'lucide-react';
import { LIBRARY_ITEM_KINDS, type LibraryItem, type LibraryItemKind } from '@shared/contract/library';
import type { Project } from '@shared/contract/project';
import { deleteLibraryItem, importLibraryFiles, listLibraryItems, updateLibraryItem } from '../../../services/libraryClient';
import { listProjects } from '../../../services/projectClient';
import ipcService from '../../../services/ipcService';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { Button } from '../../primitives/Button';
import { IconButton } from '../../primitives/IconButton';
import { Input } from '../../primitives/Input';
import { Modal } from '../../primitives/Modal';
import { Textarea } from '../../primitives/Textarea';

const GLOBAL_SCOPE = 'global';

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

function matchesSearch(item: LibraryItem, query: string): boolean {
  const haystack = [item.title, item.summary, item.pathOrUri, ...item.tags]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

export const LibraryPanel: React.FC = () => {
  const { t, language } = useI18n();
  const setShowLibraryPanel = useAppStore((s) => s.setShowLibraryPanel);
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
      .filter((item) => matchesSearch(item, search))
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

  return (
    <FullScreenPage testId="library-panel">
      <FullScreenPageHeader
        icon={<BookOpen className="h-4 w-4 text-indigo-300" />}
        title={t.library.panelTitle}
        description={t.library.panelDescription}
        onClose={() => setShowLibraryPanel(false)}
        closeLabel={t.common.close}
        actions={(
          <div className="flex items-center gap-2">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              data-testid="library-scope-select"
              className="h-8 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-300 outline-none focus:border-zinc-600"
            >
              <option value={GLOBAL_SCOPE}>{t.library.scopeGlobal}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <select
              value={selectedKind}
              onChange={(event) => setSelectedKind(event.target.value as LibraryItemKind | 'all')}
              data-testid="library-kind-filter"
              className="h-8 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-300 outline-none focus:border-zinc-600"
            >
              <option value="all">{t.library.allTypes}</option>
              {LIBRARY_ITEM_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}
            </select>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t.library.searchPlaceholder}
              aria-label={t.library.searchPlaceholder}
              data-testid="library-search"
              className="h-8 w-52 text-xs"
            />
            <Button
              variant="ghost"
              size="sm"
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
        )}
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
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
                  <th className="w-[38%] px-3 py-2 font-medium">{t.library.nameColumn}</th>
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
                      <th colSpan={5} className="px-3 py-2 text-left font-medium text-zinc-300">
                        <button type="button" onClick={() => toggleGroup(group.id)} className="inline-flex items-center gap-1.5 hover:text-white" aria-expanded={!collapsed}>
                          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          <span>{group.name}</span>
                          <span className="text-[11px] font-normal text-zinc-500">{t.library.groupCount.replace('{count}', String(group.items.length))}</span>
                        </button>
                      </th>
                    </tr>
                    {!collapsed && group.items.map((item) => (
                      <tr key={item.id} data-library-item={item.id} className="group border-t border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-800/50">
                        <td className="px-3 py-2.5">
                          <div className="flex min-w-0 items-start gap-2">
                            <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-zinc-800">{KIND_ICONS[item.kind]}</span>
                            <div className="min-w-0"><div className="truncate text-sm text-zinc-200">{item.title}</div><div className="mt-0.5 truncate text-[11px] text-zinc-500">{item.summary || item.pathOrUri}</div><div className="mt-1 flex flex-wrap gap-1">{item.tags.map((tag) => <span key={tag} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{tag}</span>)}</div></div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-zinc-400">{kindLabels[item.kind]}</td>
                        <td className="truncate px-3 py-2.5 text-zinc-400">{item.sourceRoleId || t.library.sourceUpload}</td>
                        <td className="px-3 py-2.5 text-zinc-500">{new Date(item.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}</td>
                        <td className="px-3 py-2.5"><div className="flex items-center gap-1"><IconButton variant="ghost" size="sm" data-testid={`library-edit-${item.id}`} onClick={() => openEdit(item)} title={t.library.edit} aria-label={t.library.edit} icon={<Pencil className="h-3.5 w-3.5" />} /><IconButton variant="danger" size="sm" data-testid={`library-delete-${item.id}`} onClick={() => void handleDelete(item.id)} className={confirmingDelete === item.id ? 'bg-red-500/20 text-red-300' : ''} title={confirmingDelete === item.id ? t.library.deleteConfirm : t.library.deleteAction} aria-label={confirmingDelete === item.id ? t.library.deleteConfirm : t.library.deleteAction} icon={<Trash2 className="h-3.5 w-3.5" />} /></div></td>
                      </tr>
                    ))}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </div>

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
