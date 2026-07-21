// ============================================================================
// LibraryPanel - 资料库全屏页（Batch 2 L3）
// ============================================================================
//
// 项目资产一等公民面：按作用域（全局/项目）列条目，上传文件入库，删除条目。
// pin 进会话在聊天输入区的 LibraryPinModal 里做，本页只管资产面。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, Globe, Loader2, Package, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { LibraryItem, LibraryItemKind } from '@shared/contract/library';
import type { Project } from '@shared/contract/project';
import { deleteLibraryItem, importLibraryFiles, listLibraryItems } from '../../../services/libraryClient';
import { listProjects } from '../../../services/projectClient';
import ipcService from '../../../services/ipcService';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { Button } from '../../primitives/Button';
import { IconButton } from '../../primitives/IconButton';

const GLOBAL_SCOPE = 'global';

const KIND_ICONS: Record<LibraryItemKind, React.ReactNode> = {
  upload: <FileText className="h-3.5 w-3.5 text-sky-300" />,
  artifact: <Package className="h-3.5 w-3.5 text-emerald-300" />,
  capture: <BookOpen className="h-3.5 w-3.5 text-amber-300" />,
  external_ref: <Globe className="h-3.5 w-3.5 text-purple-300" />,
};

export const LibraryPanel: React.FC = () => {
  const { t, language } = useI18n();
  const setShowLibraryPanel = useAppStore((s) => s.setShowLibraryPanel);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [projects, setProjects] = useState<Project[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const projectId = scope === GLOBAL_SCOPE ? null : scope;

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
        ) : (
          <div className="space-y-1" data-testid="library-item-list">
            {items.map((item) => (
              <div
                key={item.id}
                data-library-item={item.id}
                className="group flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 hover:border-zinc-700"
              >
                <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-zinc-800">
                  {KIND_ICONS[item.kind]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-zinc-200">{item.title}</span>
                    {item.tags.map((tag) => (
                      <span key={tag} className="flex-shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                    {item.summary || item.pathOrUri}
                  </div>
                </div>
                <span className="mt-1 flex-shrink-0 text-[10px] text-zinc-600">
                  {new Date(item.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}
                </span>
                <IconButton
                  variant="danger"
                  size="sm"
                  data-testid={`library-delete-${item.id}`}
                  onClick={() => void handleDelete(item.id)}
                  className={`mt-0.5 flex-shrink-0 ${
                    confirmingDelete === item.id
                      ? 'bg-red-500/20 text-red-300'
                      : 'opacity-0 group-hover:opacity-100'
                  }`}
                  title={confirmingDelete === item.id ? t.library.deleteConfirm : t.library.deleteAction}
                  aria-label={confirmingDelete === item.id ? t.library.deleteConfirm : t.library.deleteAction}
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </FullScreenPage>
  );
};
