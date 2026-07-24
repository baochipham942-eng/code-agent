import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FolderPlus, Loader2, Settings2, Trash2, X } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ProjectDetail, ProjectSourceInput } from '@shared/contract/project';
import ipcService from '../services/ipcService';
import {
  deleteProject,
  getProjectDetail,
  updateProject,
} from '../services/projectClient';

export interface ProjectSettingsDialogProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onSaved?: (detail: ProjectDetail | null) => void;
}

function toDraft(detail: ProjectDetail): ProjectSourceInput[] {
  return detail.sources.map((source) => ({
    id: source.id,
    path: source.path,
    role: source.role,
    access: source.access,
    trustState: source.trustState,
  }));
}

export const ProjectSettingsDialog: React.FC<ProjectSettingsDialogProps> = ({
  projectId,
  open,
  onClose,
  onSaved,
}) => {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sources, setSources] = useState<ProjectSourceInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void getProjectDetail(projectId).then((next) => {
      if (cancelled) return;
      setDetail(next);
      setName(next.project.name);
      setDescription(next.project.description ?? '');
      setSources(toDraft(next));
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const primary = useMemo(() => sources.find((source) => source.role === 'primary'), [sources]);
  if (!open) return null;

  const addFolder = async (): Promise<void> => {
    const selected = await ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'selectDirectory');
    if (!selected) return;
    await ipcService.invokeDomain(IPC_DOMAINS.FOLDER_TRUST, 'set', {
      workingDirectory: selected,
      state: 'trusted',
      decidedBy: 'project-settings',
    });
    setSources((current) => [
      ...current,
      { path: selected, role: 'additional', access: 'read_only', trustState: 'trusted' },
    ]);
  };

  const save = async (): Promise<void> => {
    if (!detail || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProject({
        projectId,
        revision: detail.project.sourceRevision ?? 0,
        name: name.trim(),
        description: description.trim() || null,
        sources,
      });
      setDetail(updated);
      setSources(toDraft(updated));
      onSaved?.(updated);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = (index: number): void => {
    setSources((current) => current.filter((_, sourceIndex) => sourceIndex !== index));
  };

  const setPrimary = (index: number): void => {
    setSources((current) => current.map((source, sourceIndex) => ({
      ...source,
      role: sourceIndex === index ? 'primary' : 'additional',
      access: sourceIndex === index ? 'read_write' : source.access,
    })));
  };

  const setAccess = (index: number, access: 'read_only' | 'read_write'): void => {
    if (access === 'read_write') {
      const source = sources[index];
      if (!window.confirm(`允许 Agent Neo 写入这个 Source？\n${source.path}`)) return;
    }
    setSources((current) => current.map((source, sourceIndex) => (
      sourceIndex === index ? { ...source, access } : source
    )));
  };

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm('删除项目只会移除 Neo 中的项目关系，不会删除磁盘上的文件或 Git 仓库。继续？')) return;
    setBusy(true);
    try {
      await deleteProject(projectId);
      onSaved?.(null);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="编辑项目">
      <div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Settings2 className="h-4 w-4 text-violet-300" />
          <h2 className="flex-1 text-sm font-semibold text-zinc-100">编辑项目</h2>
          <button type="button" onClick={onClose} aria-label="关闭"><X className="h-4 w-4 text-zinc-400" /></button>
        </header>
        <div className="grid gap-4 overflow-y-auto p-4 text-xs">
          <label className="grid gap-1 text-zinc-400">
            项目名称
            <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100" />
          </label>
          <label className="grid gap-1 text-zinc-400">
            描述
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100" />
          </label>
          <section className="grid gap-2">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-zinc-200">Source folders</h3>
                <p className="text-[11px] text-zinc-500">Primary 提供项目配置；Additional 默认只读，不自动加载 Hooks、MCP、Skills 或 Commands。</p>
              </div>
              <button type="button" onClick={() => { void addFolder(); }} className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800">
                <FolderPlus className="h-3.5 w-3.5" /> 添加文件夹
              </button>
            </div>
            {sources.map((source, index) => (
              <div key={source.id ?? `${source.path}-${index}`} data-testid="project-source-row" className="grid gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-zinc-200">{source.path}</span>
                      {source.role === 'primary' && <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-200">Primary</span>}
                    </div>
                    <span className="text-[10px] text-zinc-500">{source.trustState === 'trusted' ? 'Folder Trust 已授权' : '等待 Folder Trust'}</span>
                  </div>
                  {source.role !== 'primary' && (
                    <button type="button" onClick={() => remove(index)} className="text-zinc-500 hover:text-rose-300">移除</button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Source 权限 ${source.path}`}
                    value={source.access}
                    disabled={source.role === 'primary'}
                    onChange={(event) => setAccess(index, event.target.value as 'read_only' | 'read_write')}
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-300 disabled:opacity-60"
                  >
                    <option value="read_only">只读</option>
                    <option value="read_write">读写</option>
                  </select>
                  {source.role !== 'primary' && (
                    <button type="button" onClick={() => setPrimary(index)} className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800">设为主目录</button>
                  )}
                </div>
              </div>
            ))}
            {!primary && <p className="text-rose-300">必须选择一个 Primary source。</p>}
          </section>
          <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            运行中的 Run 使用启动时的不可变 Source 快照。这里的修改从下一次 Run 生效。
          </div>
          {error && <p role="alert" className="rounded-md bg-rose-500/10 p-2 text-rose-300">{error}</p>}
        </div>
        <footer className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">
          <button type="button" onClick={() => { void handleDelete(); }} className="inline-flex items-center gap-1 text-rose-300 hover:text-rose-200">
            <Trash2 className="h-3.5 w-3.5" /> 删除项目
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300">取消</button>
          <button type="button" disabled={busy || !primary || !name.trim()} onClick={() => { void save(); }} className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 font-medium text-white disabled:opacity-50">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} 保存
          </button>
        </footer>
      </div>
    </div>
  );
};
