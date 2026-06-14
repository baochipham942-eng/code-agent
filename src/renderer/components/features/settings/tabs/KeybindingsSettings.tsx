import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Keyboard, RotateCcw, Search, Trash2 } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import {
  KEYBINDING_DEFINITIONS,
  createDefaultKeybindingsSettings,
  detectKeybindingConflicts,
  detectKeybindingSystemWarnings,
  eventToAccelerator,
  formatShortcutForDisplay,
  getCurrentKeybindingPlatform,
  getDefaultKeybinding,
  mergeKeybindingsWithDefaults,
  type KeybindingActionId,
  type KeybindingCategory,
  type KeybindingDefinition,
  type KeybindingSetting,
  type KeybindingsSettings as KeybindingsSettingsContract,
} from '@shared/keybindings';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { emitKeybindingsChanged } from '../../../../hooks/useKeybindingsSettings';

const logger = createLogger('KeybindingsSettings');

const CATEGORY_LABELS: Record<KeybindingCategory, string> = {
  global: '全局唤起',
  sessionEditing: '会话编辑',
  delivery: '交付物',
  workbench: '工作台',
  settings: '设置与能力',
};

const SCOPE_LABELS: Record<string, string> = {
  global: '全局',
  session: '会话',
  composer: '输入区',
  artifact: '交付物',
  workbench: '工作台',
  settings: '设置',
};

function replaceBinding(
  settings: KeybindingsSettingsContract,
  actionId: KeybindingActionId,
  binding: KeybindingSetting
): KeybindingsSettingsContract {
  return {
    ...settings,
    bindings: {
      ...settings.bindings,
      [actionId]: binding,
    },
  };
}

export const KeybindingsSettings: React.FC = () => {
  const platform = useMemo(() => getCurrentKeybindingPlatform(), []);
  const [keybindings, setKeybindings] = useState<KeybindingsSettingsContract>(() =>
    createDefaultKeybindingsSettings(platform)
  );
  const [query, setQuery] = useState('');
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const settings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
        if (!cancelled) {
          setKeybindings(mergeKeybindingsWithDefaults(settings?.keybindings, platform));
        }
      } catch (error) {
        logger.error('Failed to load keybindings', error);
        if (!cancelled) setLoadError('快捷键设置加载失败');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const mergedKeybindings = useMemo(
    () => mergeKeybindingsWithDefaults(keybindings, platform),
    [keybindings, platform]
  );

  const persistKeybindings = useCallback(async (next: KeybindingsSettingsContract) => {
    setKeybindings(next);
    setSaving(true);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        keybindings: next,
      } as Partial<AppSettings>);
      emitKeybindingsChanged(next);
    } catch (error) {
      logger.error('Failed to save keybindings', error);
    } finally {
      setSaving(false);
    }
  }, []);

  const updateBinding = useCallback((actionId: KeybindingActionId, binding: KeybindingSetting) => {
    const next = replaceBinding(mergedKeybindings, actionId, binding);
    void persistKeybindings(next);
  }, [mergedKeybindings, persistKeybindings]);

  const resetAction = useCallback((actionId: KeybindingActionId) => {
    const defaultBinding = getDefaultKeybinding(actionId, platform) || {
      enabled: false,
      accelerator: null,
    };
    updateBinding(actionId, defaultBinding);
  }, [platform, updateBinding]);

  const resetAll = useCallback(() => {
    void persistKeybindings(createDefaultKeybindingsSettings(platform));
  }, [persistKeybindings, platform]);

  const updateGlobalHotkeysEnabled = useCallback((enabled: boolean) => {
    void persistKeybindings({
      ...mergedKeybindings,
      globalHotkeysEnabled: enabled,
    });
  }, [mergedKeybindings, persistKeybindings]);

  useEffect(() => {
    if (!recordingActionId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecordingActionId(null);
        return;
      }

      const accelerator = eventToAccelerator(event, platform);
      if (!accelerator) return;

      updateBinding(recordingActionId, {
        enabled: true,
        accelerator,
      });
      setRecordingActionId(null);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [platform, recordingActionId, updateBinding]);

  const conflicts = useMemo(
    () => detectKeybindingConflicts(mergedKeybindings, platform),
    [mergedKeybindings, platform]
  );
  const systemWarnings = useMemo(
    () => detectKeybindingSystemWarnings(mergedKeybindings, platform),
    [mergedKeybindings, platform]
  );
  const conflictActionIds = useMemo(() => new Set(conflicts.flatMap((conflict) => conflict.actionIds)), [conflicts]);
  const systemWarningActionIds = useMemo(
    () => new Set(systemWarnings.map((warning) => warning.actionId)),
    [systemWarnings]
  );

  const normalizedQuery = query.trim().toLowerCase();
  const filteredDefinitions = useMemo(() => {
    if (!normalizedQuery) return KEYBINDING_DEFINITIONS;
    return KEYBINDING_DEFINITIONS.filter((definition) => {
      const haystack = [
        definition.id,
        definition.label,
        definition.description,
        CATEGORY_LABELS[definition.category],
        SCOPE_LABELS[definition.scope],
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery]);

  const groupedDefinitions = useMemo(() => {
    const groups = new Map<KeybindingCategory, KeybindingDefinition[]>();
    for (const definition of filteredDefinitions) {
      const nextGroup = [...(groups.get(definition.category) || []), definition];
      groups.set(definition.category, nextGroup);
    }
    return [...groups.entries()];
  }, [filteredDefinitions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-200">快捷键配置</h3>
          <p className="mt-1 text-xs text-zinc-500">
            当前平台：{platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'}。冲突按作用域提示，系统保留组合键单独提醒。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={mergedKeybindings.globalHotkeysEnabled !== false}
            onClick={() => updateGlobalHotkeysEnabled(mergedKeybindings.globalHotkeysEnabled === false)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
              mergedKeybindings.globalHotkeysEnabled !== false
                ? 'border-primary-600/70 bg-primary-500/10 text-primary-100'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-800'
            }`}
          >
            系统级热键
            <span className={`h-2 w-2 rounded-full ${mergedKeybindings.globalHotkeysEnabled !== false ? 'bg-primary-300' : 'bg-zinc-600'}`} />
          </button>
          <button
            type="button"
            onClick={resetAll}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
          >
            <RotateCcw className="h-4 w-4" />
            恢复默认
          </button>
        </div>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          <AlertTriangle className="h-4 w-4" />
          {loadError}
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-700/50 bg-amber-950/30 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            存在快捷键冲突
          </div>
          {conflicts.map((conflict) => (
            <div key={`${conflict.scope}:${conflict.normalizedShortcut}`} className="text-xs text-amber-100/80">
              {SCOPE_LABELS[conflict.scope]} · {formatShortcutForDisplay(conflict.shortcut, platform)}：{conflict.labels.join(' / ')}
            </div>
          ))}
        </div>
      )}

      {systemWarnings.length > 0 && (
        <div className="space-y-2 rounded-lg border border-sky-700/40 bg-sky-950/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-sky-200">
            <AlertTriangle className="h-4 w-4" />
            可能被系统占用
          </div>
          {systemWarnings.map((warning) => (
            <div key={`${warning.actionId}:${warning.normalizedShortcut}`} className="text-xs text-sky-100/80">
              {warning.label} · {formatShortcutForDisplay(warning.shortcut, platform)}：{warning.reason}
            </div>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-zinc-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索快捷键、功能或作用域"
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
        />
      </label>

      <div className="space-y-6">
        {groupedDefinitions.map(([category, definitions]) => (
          <section key={category} className="space-y-2">
            <div className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-zinc-500" />
              <h3 className="text-sm font-medium text-zinc-200">{CATEGORY_LABELS[category]}</h3>
            </div>
            <div className="overflow-hidden rounded-lg border border-zinc-800">
              {definitions.map((definition) => {
                const binding = mergedKeybindings.bindings[definition.id] || {
                  enabled: false,
                  accelerator: null,
                };
                const hasConflict = conflictActionIds.has(definition.id);
                const hasSystemWarning = systemWarningActionIds.has(definition.id);
                const defaultBinding = getDefaultKeybinding(definition.id, platform);
                const shortcutLabel = recordingActionId === definition.id
                  ? '按下组合键...'
                  : formatShortcutForDisplay(binding.accelerator, platform);
                return (
                  <div
                    key={definition.id}
                    className={`grid gap-3 border-b border-zinc-800 bg-zinc-950/40 p-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_220px_108px] md:items-center ${
                      hasConflict ? 'bg-amber-950/10' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium text-zinc-200">{definition.label}</div>
                        <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-500">
                          {SCOPE_LABELS[definition.scope]}
                        </span>
                        {definition.risk === 'destructive' && (
                          <span className="rounded border border-red-900/70 px-1.5 py-0.5 text-[11px] text-red-300">
                            高风险
                          </span>
                        )}
                        {hasConflict && (
                          <span className="rounded border border-amber-700/60 px-1.5 py-0.5 text-[11px] text-amber-200">
                            冲突
                          </span>
                        )}
                        {hasSystemWarning && (
                          <span className="rounded border border-sky-700/60 px-1.5 py-0.5 text-[11px] text-sky-200">
                            系统占用
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">{definition.description}</p>
                      <p className="mt-1 text-[11px] text-zinc-600">
                        默认：{formatShortcutForDisplay(defaultBinding?.accelerator, platform)}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={!definition.configurable}
                      onClick={() => setRecordingActionId(definition.id)}
                      className={`h-10 rounded-lg border px-3 text-sm transition-colors ${
                        recordingActionId === definition.id
                          ? 'border-primary-500 bg-primary-500/10 text-primary-200'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800'
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      {shortcutLabel}
                    </button>

                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={binding.enabled}
                        onClick={() => updateBinding(definition.id, {
                          ...binding,
                          enabled: !binding.enabled,
                        })}
                        className={`relative h-6 w-11 rounded-full transition-colors ${
                          binding.enabled ? 'bg-primary-500' : 'bg-zinc-700'
                        }`}
                        title={binding.enabled ? '停用快捷键' : '启用快捷键'}
                      >
                        <span
                          className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                            binding.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => updateBinding(definition.id, { enabled: false, accelerator: null })}
                        className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        title="清空快捷键"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => resetAction(definition.id)}
                        className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        title="恢复该项默认"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="text-xs text-zinc-600">
        {saving ? '正在保存...' : '修改会自动保存。系统级热键会在桌面运行时重新注册，失败项会保留在配置中并记录诊断日志。'}
      </div>
    </div>
  );
};
