import React, { useCallback, useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import type { AgentEngineModelCatalogResult, ExternalAgentEngineKind } from '@shared/contract/agentEngine';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { Select } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';

const logger = createLogger('AgentEngineModelCatalogSection');

const AGENT_ENGINE_LABELS: Record<ExternalAgentEngineKind, string> = {
  codex_cli: 'Codex',
  claude_code: 'Claude',
  mimo_code: 'MiMo',
  kimi_code: 'Kimi',
};

function formatCatalogDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export const AgentEngineModelCatalogSection: React.FC = () => {
  const { t } = useI18n();
  const section = t.engineCompat.catalogSection;
  const [catalogResult, setCatalogResult] = useState<AgentEngineModelCatalogResult | null>(null);
  const [defaults, setDefaults] = useState<Partial<Record<ExternalAgentEngineKind, string>>>({});
  const [savingDefault, setSavingDefault] = useState<ExternalAgentEngineKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (!cancelled) {
          setDefaults({
            codex_cli: settings?.models?.agentEngines?.codex_cli?.defaultModel,
            claude_code: settings?.models?.agentEngines?.claude_code?.defaultModel,
          });
        }
      })
      .catch((error: unknown) => {
        logger.warn('Failed to load Agent Engine defaults', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AgentEngineModelCatalogResult>(IPC_DOMAINS.AGENT_ENGINE, 'listModels')
      .then((result) => {
        if (!cancelled) setCatalogResult(result);
      })
      .catch((error: unknown) => {
        logger.warn('Failed to load Agent Engine model catalog', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDefaultChange = useCallback(async (kind: ExternalAgentEngineKind, modelId: string) => {
    setDefaults((prev) => ({ ...prev, [kind]: modelId }));
    setSavingDefault(kind);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        models: {
          agentEngines: {
            [kind]: {
              defaultModel: modelId,
              updatedAt: Date.now(),
            },
          },
        },
      } as Partial<AppSettings>);
      toast.success(section.defaultUpdated.replace('{engine}', AGENT_ENGINE_LABELS[kind]));
    } catch (error) {
      toast.error(
        section.saveFailed.replace(
          '{error}',
          error instanceof Error ? error.message : section.unknownError,
        ),
      );
    } finally {
      setSavingDefault(null);
    }
  }, [section]);

  return (
    <SettingsSection
      title={section.title}
      description={section.description}
    >
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
        <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
          {[
            [section.versionLabel, catalogResult?.catalog.version ?? '-', section.versionCaption],
            [section.sourceLabel, catalogResult?.source === 'remote' ? section.sourceRemote : catalogResult?.source === 'bundled' ? section.sourceBundled : '-', section.sourceCaption],
            [section.updatedAtLabel, formatCatalogDate(catalogResult?.catalog.updatedAt), section.updatedAtCaption],
            [section.engineCountLabel, String(catalogResult?.catalog.engines.length ?? 0), section.engineCountCaption],
          ].map(([label, value, caption]) => (
            <div key={label} className="bg-zinc-900/80 px-3 py-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
              <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
              <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
            </div>
          ))}
        </div>

        <div className="divide-y divide-zinc-800/80">
          {(catalogResult?.catalog.engines ?? []).map((engine) => {
            const enabledModels = engine.models.filter((model) => !model.disabledReason);
            const localDefault = defaults[engine.kind];
            const selectedDefault = enabledModels.some((model) => model.id === localDefault)
              ? localDefault
              : enabledModels.find((model) => model.id === engine.defaultModel)?.id ?? enabledModels[0]?.id ?? engine.defaultModel;
            return (
              <div
                key={engine.kind}
                className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(160px,0.8fr)_minmax(180px,1fr)_minmax(220px,1.2fr)] lg:items-center"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                    <Terminal className="h-4 w-4 text-zinc-400" />
                    <span>{AGENT_ENGINE_LABELS[engine.kind]}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={engine.defaultModel}>
                    {section.remoteDefaultLabel}：{engine.defaultModel}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-medium text-zinc-400">
                    {section.localDefaultLabel}
                  </label>
                  <Select
                    value={selectedDefault}
                    onChange={(event) => void handleDefaultChange(engine.kind, event.target.value)}
                    selectSize="sm"
                    disabled={isWebMode() || enabledModels.length === 0 || savingDefault === engine.kind}
                  >
                    {enabledModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="min-w-0 text-xs text-zinc-400">
                  <div>
                    {section.modelSelectableSummary
                      .replace('{enabled}', String(enabledModels.length))
                      .replace('{total}', String(engine.models.length))}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {engine.models.slice(0, 5).map((model) => (
                      <span
                        key={model.id}
                        className={`rounded border px-1.5 py-0.5 ${
                          model.disabledReason
                            ? 'border-zinc-700 bg-zinc-800 text-zinc-500'
                            : model.recommended
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-300'
                        }`}
                        title={model.disabledReason || model.id}
                      >
                        {model.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {!catalogResult ? (
            <div className="px-3 py-4 text-sm text-zinc-500">
              {section.loading}
            </div>
          ) : null}
        </div>

        {catalogResult?.diagnostics.length ? (
          <div className="border-t border-zinc-800 px-3 py-2 text-[11px] text-amber-300">
            {catalogResult.diagnostics[0]?.message}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
};
