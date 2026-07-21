// ============================================================================
// RoleBindingsSection — 专家 L1 资料架配置面（Batch 3 E3，嵌入 RoleDetailView）
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { BookMarked, FileText, Folder, Library, Trash2 } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ExpertBindingKind, ExpertBindingMode, ExpertBindingScope, ExpertContextBinding } from '@shared/contract/roleAssets';
import type { LibraryItem } from '@shared/contract/library';
import ipcService from '../../../../services/ipcService';
import { listLibraryItems } from '../../../../services/libraryClient';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { IconButton } from '../../../primitives/IconButton';
import { Button } from '../../../primitives/Button';

const KIND_ICONS: Record<ExpertBindingKind, React.ReactNode> = {
  file: <FileText className="h-3.5 w-3.5 text-sky-300" />,
  folder: <Folder className="h-3.5 w-3.5 text-amber-300" />,
  library_item: <Library className="h-3.5 w-3.5 text-emerald-300" />,
};

async function fetchBindings(roleId: string): Promise<ExpertContextBinding[]> {
  return ipcService.invokeDomain<ExpertContextBinding[]>(IPC_DOMAINS.ROLES, 'listBindings', { roleId });
}

export const RoleBindingsSection: React.FC<{ roleId: string }> = ({ roleId }) => {
  const { t } = useI18n();
  const text = t.settings.roles.bindings;

  const [bindings, setBindings] = useState<ExpertContextBinding[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [mode, setMode] = useState<ExpertBindingMode>('always');
  const [scope, setScope] = useState<ExpertBindingScope>('private');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBindings(await fetchBindings(roleId));
    } catch (error) {
      toast.error(text.loadFailed + (error instanceof Error ? `: ${error.message}` : ''));
    }
  }, [roleId, text]);

  useEffect(() => {
    void load();
    listLibraryItems().then(setLibraryItems).catch(() => setLibraryItems([]));
  }, [load]);

  const add = async (kind: ExpertBindingKind, target: string) => {
    if (!target.trim()) return;
    setBusy(true);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'addBinding', {
        roleId,
        kind,
        target: target.trim(),
        mode,
        scope,
      });
      setPathInput('');
      setSelectedItemId('');
      await load();
    } catch (error) {
      toast.error(text.addFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (bindingId: string) => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'removeBinding', { roleId, bindingId });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="mt-4" data-testid="role-bindings-section">
      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-zinc-200">
        <BookMarked className="h-4 w-4 text-violet-300" />
        {text.title}
      </div>
      <p className="mb-2 text-xs text-zinc-500">{text.hint}</p>

      {bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">
          {text.empty}
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {bindings.map((binding) => (
            <li
              key={binding.id}
              data-testid={`role-binding-${binding.id}`}
              className="flex items-center gap-2 rounded-md bg-zinc-800/50 px-2 py-1.5"
            >
              {KIND_ICONS[binding.kind]}
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={binding.target}>
                {binding.title || binding.target}
              </span>
              <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {binding.mode === 'always' ? text.modeAlways : text.modeOnDemand}
              </span>
              <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
                {binding.scope === 'private' ? text.scopePrivate : text.scopeProject}
              </span>
              <IconButton
                icon={<Trash2 className="h-3.5 w-3.5" />}
                aria-label={text.remove}
                title={text.remove}
                size="sm"
                variant="ghost"
                onClick={() => void remove(binding.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ExpertBindingMode)}
            data-testid="role-binding-mode"
            className="h-7 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-600"
          >
            <option value="always">{text.modeAlways}</option>
            <option value="on_demand">{text.modeOnDemand}</option>
          </select>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as ExpertBindingScope)}
            data-testid="role-binding-scope"
            className="h-7 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-600"
          >
            <option value="private">{text.scopePrivate}</option>
            <option value="project">{text.scopeProject}</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedItemId}
            onChange={(e) => setSelectedItemId(e.target.value)}
            data-testid="role-binding-library-select"
            className="h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-600"
          >
            <option value="">{text.librarySelectPlaceholder}</option>
            {libraryItems.map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !selectedItemId}
            data-testid="role-binding-add-library"
            onClick={() => void add('library_item', selectedItemId)}
          >
            {text.addFromLibrary}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder={text.pathPlaceholder}
            data-testid="role-binding-path-input"
            className="h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !pathInput.trim()}
            data-testid="role-binding-add-path"
            onClick={() => void add('file', pathInput) /* host 侧按盘上真实形态归一 file/folder */}
          >
            {text.addPath}
          </Button>
        </div>
      </div>
    </div>
  );
};
