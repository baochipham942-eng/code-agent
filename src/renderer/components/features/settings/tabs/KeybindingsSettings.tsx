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
  type KeybindingPlatform,
  type KeybindingSetting,
  type KeybindingsSettings as KeybindingsSettingsContract,
} from '@shared/keybindings';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { emitKeybindingsChanged } from '../../../../hooks/useKeybindingsSettings';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { Toggle } from '../../../primitives/Toggle';

const logger = createLogger('KeybindingsSettings');

type KeybindingsSettingsText = typeof zh.settings.keybindings;

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

function getSystemReservedReason(
  text: KeybindingsSettingsText,
  platform: KeybindingPlatform,
  shortcut: string,
  fallback: string
): string {
  const reasons = text.systemReservedReasons[platform] as Record<string, string>;
  return reasons[shortcut] ?? fallback;
}

export const KeybindingsSettings: React.FC = () => {
  const { t } = useI18n();
  const keybindingsText = t.settings.keybindings;
  const platform = useMemo(() => getCurrentKeybindingPlatform(), []);
  const [keybindings, setKeybindings] = useState<KeybindingsSettingsContract>(() =>
    createDefaultKeybindingsSettings(platform)
  );
  const [query, setQuery] = useState('');
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

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
        if (!cancelled) setLoadError(keybindingsText.loadError);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [keybindingsText.loadError, platform]);

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
      const actionText = keybindingsText.actions[definition.id];
      const haystack = [
        definition.id,
        actionText.label,
        actionText.description,
        keybindingsText.categories[definition.category],
        keybindingsText.scopes[definition.scope],
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [keybindingsText, normalizedQuery]);

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
          <h3 className="text-sm font-medium text-zinc-200">{keybindingsText.title}</h3>
          <p className="mt-1 text-xs text-zinc-500">
            {keybindingsText.platformPrefix}
            {platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'}
            {keybindingsText.platformSuffix}
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
            {keybindingsText.globalHotkeys}
            <span className={`h-2 w-2 rounded-full ${mergedKeybindings.globalHotkeysEnabled !== false ? 'bg-primary-300' : 'bg-zinc-600'}`} />
          </button>
          <button
            type="button"
            onClick={() => setIsResetConfirmOpen(true)}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
          >
            <RotateCcw className="h-4 w-4" />
            {keybindingsText.resetDefaults}
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
            {keybindingsText.conflictTitle}
          </div>
          {conflicts.map((conflict) => {
            const conflictLabels = conflict.actionIds
              .map((actionId, index) => keybindingsText.actions[actionId]?.label ?? conflict.labels[index] ?? actionId)
              .join(' / ');
            return (
              <div key={`${conflict.scope}:${conflict.normalizedShortcut}`} className="text-xs text-amber-100/80">
                {keybindingsText.scopes[conflict.scope]} · {formatShortcutForDisplay(conflict.shortcut, platform)}：{conflictLabels}
              </div>
            );
          })}
        </div>
      )}

      {systemWarnings.length > 0 && (
        <div className="space-y-2 rounded-lg border border-sky-700/40 bg-sky-950/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-sky-200">
            <AlertTriangle className="h-4 w-4" />
            {keybindingsText.systemWarningTitle}
          </div>
          {systemWarnings.map((warning) => (
            <div key={`${warning.actionId}:${warning.normalizedShortcut}`} className="text-xs text-sky-100/80">
              {keybindingsText.actions[warning.actionId].label} · {formatShortcutForDisplay(warning.shortcut, platform)}：
              {getSystemReservedReason(keybindingsText, platform, warning.normalizedShortcut, warning.reason)}
            </div>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-zinc-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={keybindingsText.searchPlaceholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
        />
      </label>

      <div className="space-y-6">
        {groupedDefinitions.map(([category, definitions]) => (
          <section key={category} className="space-y-2">
            <div className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-zinc-500" />
              <h3 className="text-sm font-medium text-zinc-200">{keybindingsText.categories[category]}</h3>
            </div>
            <div className="overflow-hidden rounded-lg border border-zinc-800">
              {definitions.map((definition) => {
                const actionText = keybindingsText.actions[definition.id];
                const binding = mergedKeybindings.bindings[definition.id] || {
                  enabled: false,
                  accelerator: null,
                };
                const hasConflict = conflictActionIds.has(definition.id);
                const hasSystemWarning = systemWarningActionIds.has(definition.id);
                const defaultBinding = getDefaultKeybinding(definition.id, platform);
                const shortcutLabel = recordingActionId === definition.id
                  ? keybindingsText.recording
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
                        <div className="text-sm font-medium text-zinc-200">{actionText.label}</div>
                        <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-500">
                          {keybindingsText.scopes[definition.scope]}
                        </span>
                        {definition.risk === 'destructive' && (
                          <span className="rounded border border-red-900/70 px-1.5 py-0.5 text-[11px] text-red-300">
                            {keybindingsText.destructiveRisk}
                          </span>
                        )}
                        {hasConflict && (
                          <span className="rounded border border-amber-700/60 px-1.5 py-0.5 text-[11px] text-amber-200">
                            {keybindingsText.conflictBadge}
                          </span>
                        )}
                        {hasSystemWarning && (
                          <span className="rounded border border-sky-700/60 px-1.5 py-0.5 text-[11px] text-sky-200">
                            {keybindingsText.systemWarningBadge}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">{actionText.description}</p>
                      <p className="mt-1 text-[11px] text-zinc-600">
                        {keybindingsText.defaultPrefix}{formatShortcutForDisplay(defaultBinding?.accelerator, platform)}
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
                      <Toggle
                        size="md"
                        checked={binding.enabled}
                        onChange={(next) => updateBinding(definition.id, {
                          ...binding,
                          enabled: next,
                        })}
                        aria-label={binding.enabled ? keybindingsText.disableShortcut : keybindingsText.enableShortcut}
                        title={binding.enabled ? keybindingsText.disableShortcut : keybindingsText.enableShortcut}
                      />
                      <button
                        type="button"
                        onClick={() => updateBinding(definition.id, { enabled: false, accelerator: null })}
                        className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        title={keybindingsText.clearShortcut}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => resetAction(definition.id)}
                        className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                        title={keybindingsText.resetShortcut}
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
        {saving ? keybindingsText.saving : keybindingsText.autosaveHint}
      </div>
      <ConfirmDialog
        isOpen={isResetConfirmOpen}
        title={keybindingsText.resetConfirmTitle}
        message={keybindingsText.resetConfirmMessage}
        variant="warning"
        confirmText={keybindingsText.resetConfirm}
        cancelText={t.common.cancel}
        onCancel={() => setIsResetConfirmOpen(false)}
        onConfirm={() => {
          setIsResetConfirmOpen(false);
          resetAll();
        }}
      />
    </div>
  );
};
