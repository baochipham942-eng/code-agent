// ============================================================================
// ExternalImportSettings - 设置页「从其他 AI 应用导入」（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 三步流：选择（来源×类别 勾选，默认全选）→ 预览（含重复与逐条确认）→ 结果。
// 记忆/说明复用既有 harness 导入管线（memoryHarnessImportDryRun/Apply/
// ConfirmDirective 域 action，不另起管线）；技能走 externalImportSkills*（Codex/
// Cursor 复制、绝不覆盖）；Claude 技能按拍板 A 原地读取，只展示计数 + 全局开关。
// 类别列数据驱动（K1B 的 MCP 类别 = IMPORT_CATEGORIES 加一档 + host handler）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FolderInput,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type {
  MemoryConfirmRequest,
  MemoryImportApplyResult,
  MemoryImportDirectiveConfirmResult,
  MemoryImportDryRunResult,
} from '@shared/contract/memory';
import type {
  ExternalImportCategory,
  ExternalImportDetectResult,
  ExternalImportSourceStatus,
  ExternalSkillsApplyResult,
  ExternalSkillsPreviewResult,
} from '@shared/contract/externalImport';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { useAppStore } from '../../../../stores/appStore';
import { useExternalImportStore } from '../../../../stores/externalImportStore';
import { Button, Toggle } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { SettingsSection } from '../SettingsLayout';

/** 页面类别列：新类别（K1B 的 MCP servers）在此加一档 + 对应 host handler。 */
const IMPORT_CATEGORIES: ExternalImportCategory[] = ['instructions', 'memories', 'skills'];

type DirectiveState = 'pending' | 'imported' | 'not-imported' | 'failed';

interface ImportResults {
  memory: MemoryImportApplyResult | null;
  skills: ExternalSkillsApplyResult | null;
  directivesImported: number;
}

type ExternalImportCopy = ReturnType<typeof useI18n>['t']['settings']['externalImport'];

function categoryLabel(category: ExternalImportCategory, copy: ExternalImportCopy): string {
  return copy.categories[category];
}

export const ExternalImportSettings: React.FC = () => {
  const { t } = useI18n();
  const copy = t.settings.externalImport;
  const detectionStatus = useExternalImportStore((state) => state.status);
  const detectionResult = useExternalImportStore((state) => state.result);
  const ensureChecked = useExternalImportStore((state) => state.ensureChecked);
  const refreshDetection = useExternalImportStore((state) => state.refresh);

  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState<'select' | 'preview' | 'results'>('select');
  const [busy, setBusy] = useState<'detect' | 'preview' | 'apply' | `directive:${string}` | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [previewMemory, setPreviewMemory] = useState<MemoryImportDryRunResult | null>(null);
  const [previewSkills, setPreviewSkills] = useState<ExternalSkillsPreviewResult | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [directiveStates, setDirectiveStates] = useState<Record<string, DirectiveState>>({});
  const [results, setResults] = useState<ImportResults | null>(null);
  // directive 确认的宿主回执走全局 memory 确认卡（z 阶梯低于设置页遮罩，会被盖住），
  // 设置页内就地接同一个 MEMORY_CONFIRM_REQUEST / _RESPONSE 通道，不新增宿主面。
  const [pendingConfirm, setPendingConfirm] = useState<MemoryConfirmRequest | null>(null);

  useEffect(() => {
    void ensureChecked();
  }, [ensureChecked]);

  useEffect(() => {
    const unsubscribe = ipcService.on(IPC_CHANNELS.MEMORY_CONFIRM_REQUEST, (request) => {
      if (request?.id) setPendingConfirm(request);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const respondPendingConfirm = async (confirmed: boolean): Promise<void> => {
    if (!pendingConfirm?.id) return;
    const id = pendingConfirm.id;
    setPendingConfirm(null);
    try {
      await ipcService.invoke(IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE, { id, confirmed });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.directiveFailed });
    }
  };

  const detectedSources = useMemo(
    () => (detectionResult?.sources ?? []).filter((source) => source.detected),
    [detectionResult],
  );

  // 默认全选：检测结果就位后给每个 来源×类别 勾上（只读类别除外）。
  useEffect(() => {
    if (!detectionResult) return;
    setSelection((current) => {
      const next = { ...current };
      for (const source of detectionResult.sources) {
        for (const category of source.categories) {
          const key = `${source.sourceId}#${category.category}`;
          if (next[key] === undefined && !category.readOnly) next[key] = true;
        }
      }
      return next;
    });
  }, [detectionResult]);

  const isSelected = useCallback(
    (sourceId: string, category: ExternalImportCategory): boolean =>
      selection[`${sourceId}#${category}`] === true,
    [selection],
  );

  const selectedAdapterIds = useMemo(
    () => detectedSources
      .filter((source) => source.adapterId
        && (isSelected(source.sourceId, 'instructions') || isSelected(source.sourceId, 'memories')))
      .map((source) => source.adapterId!),
    [detectedSources, isSelected],
  );

  const selectedSkillSourceIds = useMemo(
    () => detectedSources
      .filter((source) => source.categories.some((c) => c.category === 'skills' && !c.readOnly)
        && isSelected(source.sourceId, 'skills'))
      .map((source) => source.sourceId),
    [detectedSources, isSelected],
  );

  const toggleCategory = (sourceId: string, category: ExternalImportCategory): void => {
    const key = `${sourceId}#${category}`;
    setSelection((current) => ({ ...current, [key]: !current[key] }));
  };

  const invoke = useCallback(async <T,>(action: string, payload: unknown): Promise<T> => {
    return ipcService.invokeDomain<T>(IPC_DOMAINS.MEMORY, action, payload);
  }, []);

  const runPreview = async () => {
    if (selectedAdapterIds.length === 0 && selectedSkillSourceIds.length === 0) {
      setMessage({ type: 'error', text: copy.emptySelection });
      return;
    }
    setBusy('preview');
    setMessage(null);
    try {
      const [memory, skills] = await Promise.all([
        selectedAdapterIds.length > 0
          ? invoke<MemoryImportDryRunResult>('memoryHarnessImportDryRun', { adapterIds: selectedAdapterIds })
          : Promise.resolve(null),
        selectedSkillSourceIds.length > 0
          ? invoke<ExternalSkillsPreviewResult>('externalImportSkillsPreview', { sourceIds: selectedSkillSourceIds })
          : Promise.resolve(null),
      ]);
      setPreviewMemory(memory);
      setPreviewSkills(skills);
      setSelectedCandidateIds(new Set(
        (memory?.candidates ?? [])
          .filter((candidate) => candidate.disposition === 'add')
          .map((candidate) => candidate.id),
      ));
      setDirectiveStates(Object.fromEntries(
        (memory?.instructions ?? []).map((item) => [item.id, 'pending' as DirectiveState]),
      ));
      setResults(null);
      setStep('preview');
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.previewFailed });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy('apply');
    setMessage(null);
    try {
      const [memory, skills] = await Promise.all([
        selectedAdapterIds.length > 0 && selectedCandidateIds.size > 0
          ? invoke<MemoryImportApplyResult>('memoryHarnessImportApply', {
            adapterIds: selectedAdapterIds,
            candidateIds: Array.from(selectedCandidateIds),
          })
          : Promise.resolve(null),
        selectedSkillSourceIds.length > 0
          ? invoke<ExternalSkillsApplyResult>('externalImportSkillsApply', { sourceIds: selectedSkillSourceIds })
          : Promise.resolve(null),
      ]);
      const directivesImported = Object.values(directiveStates).filter((state) => state === 'imported').length;
      setResults({ memory, skills, directivesImported });
      setStep('results');
      await refreshDetection();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.applyFailed });
    } finally {
      setBusy(null);
    }
  };

  const confirmDirective = async (instructionId: string) => {
    setBusy(`directive:${instructionId}`);
    setMessage(null);
    try {
      const result = await invoke<MemoryImportDirectiveConfirmResult>(
        'memoryHarnessImportConfirmDirective',
        { instructionId, adapterIds: selectedAdapterIds },
      );
      setDirectiveStates((current) => ({
        ...current,
        [instructionId]: result.imported ? 'imported' : 'not-imported',
      }));
      if (!result.imported) {
        setMessage({ type: 'error', text: copy.directiveNotImported });
      }
    } catch (error) {
      setDirectiveStates((current) => ({ ...current, [instructionId]: 'failed' }));
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.directiveFailed });
    } finally {
      setBusy(null);
    }
  };

  const toggleClaudeLegacySkills = async (enabled: boolean): Promise<void> => {
    setBusy('detect');
    try {
      await invoke<{ enabled: boolean }>('externalImportSetClaudeLegacySkills', { enabled });
      await refreshDetection();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : copy.detectFailed });
    } finally {
      setBusy(null);
    }
  };

  const restartFlow = async (): Promise<void> => {
    setStep('select');
    setPreviewMemory(null);
    setPreviewSkills(null);
    setResults(null);
    setBusy('detect');
    try {
      await refreshDetection();
    } finally {
      setBusy(null);
    }
  };

  const claudeSkills = detectionResult?.claudeLegacySkills;

  if (detectionStatus === 'idle' || detectionStatus === 'checking') {
    return (
      <div data-testid="external-import-detecting" className="flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        {copy.detecting}
      </div>
    );
  }

  if (detectedSources.length === 0) {
    return (
      <div data-testid="external-import-empty" className="text-sm text-zinc-500">{copy.noSources}</div>
    );
  }

  return (
    <SettingsSection
      title={copy.title}
      description={copy.description}
    >
      <div data-testid="external-import-settings" className="space-y-4">
        <div
          data-testid="external-import-unaffected"
          className="flex items-center gap-2 rounded-lg border border-badge-success/30 bg-badge-success/10 px-3 py-2 text-xs text-badge-success"
        >
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {copy.unaffectedLine}
        </div>

        {message && (
          <div
            className={`rounded-lg px-3 py-2 text-xs ${
              message.type === 'success' ? 'bg-green-500/10 text-badge-success' : 'bg-red-500/10 text-badge-danger'
            }`}
          >
            {message.text}
          </div>
        )}

        {claudeSkills && (
          <div
            data-testid="external-import-claude-skills"
            className="flex items-center justify-between gap-3 rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-200">
                {copy.claudeSkills.title.replace('{count}', String(claudeSkills.count))}
              </div>
              <div className="mt-1 text-xs text-zinc-500">{copy.claudeSkills.hint}</div>
            </div>
            <Toggle
              checked={claudeSkills.enabled}
              onChange={(checked) => void toggleClaudeLegacySkills(checked)}
              aria-label={copy.claudeSkills.toggleLabel}
            />
          </div>
        )}

        {step === 'select' && (
          <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60" data-testid="external-import-sources">
            {detectedSources.map((source) => (
              <SourceRow
                key={source.sourceId}
                source={source}
                copy={copy}
                isSelected={isSelected}
                onToggleCategory={toggleCategory}
              />
            ))}
            <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-3 py-3">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                disabled={busy !== null}
                onClick={() => void refreshDetection()}
              >
                {copy.refresh}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                disabled={busy !== null}
                onClick={() => void runPreview()}
              >
                {copy.previewCta}
              </Button>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <PreviewStep
            copy={copy}
            previewMemory={previewMemory}
            previewSkills={previewSkills}
            selectedCandidateIds={selectedCandidateIds}
            directiveStates={directiveStates}
            busy={busy}
            onToggleCandidate={(candidateId, checked) => setSelectedCandidateIds((current) => {
              const next = new Set(current);
              if (checked) next.add(candidateId);
              else next.delete(candidateId);
              return next;
            })}
            onConfirmDirective={(instructionId) => void confirmDirective(instructionId)}
            onBack={() => setStep('select')}
            onApply={() => void apply()}
          />
        )}

        {step === 'results' && results && (
          <div className="space-y-3" data-testid="external-import-results">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <CheckCircle2 className="h-4 w-4 text-badge-success" />
              {copy.resultsTitle}
            </div>
            {results.memory && (
              <div data-testid="external-import-results-memory" className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-300">
                {copy.resultsMemory
                  .replace('{imported}', String(results.memory.imported))
                  .replace('{skipped}', String(results.memory.skipped))}
              </div>
            )}
            {results.skills && (
              <div data-testid="external-import-results-skills" className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-300">
                <div>
                  {copy.resultsSkills
                    .replace('{copied}', String(results.skills.copied))
                    .replace('{skipped}', String(results.skills.skipped))}
                </div>
                <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
                  {results.skills.items.map((item) => (
                    // 只显大白话：来源用显示名（非裸 id），原因走 i18n 标签（裸 error
                    // 只进宿主日志），路径不出现在结果页。
                    <div key={`${item.sourceId}:${item.name}`} className="truncate">
                      {copy.sourceNames[item.sourceId]} · {item.name} ·{' '}
                      {item.reason ? copy.skillReasonLabels[item.reason] : copy.skillActionLabels[item.action]}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {results.directivesImported > 0 && (
              <div data-testid="external-import-results-directives" className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-300">
                {copy.resultsDirectives.replace('{imported}', String(results.directivesImported))}
              </div>
            )}
            <div className="flex items-center gap-2">
              {results.skills && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    useAppStore.getState().openCapabilitySettingsTarget({ kind: 'skill', id: '', source: 'external-import' })
                  }
                >
                  {copy.viewSkillsCta}
                </Button>
              )}
              <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => void restartFlow()}>
                {copy.resultsAgain}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={pendingConfirm !== null}
        title={copy.directiveDialogTitle}
        message={
          <pre data-testid="external-import-directive-content" className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-zinc-300">
            {pendingConfirm?.content ?? ''}
          </pre>
        }
        confirmText={copy.directiveDialogConfirm}
        cancelText={copy.directiveDialogCancel}
        onConfirm={() => void respondPendingConfirm(true)}
        onCancel={() => void respondPendingConfirm(false)}
      />
    </SettingsSection>
  );
};

function SourceRow({
  source,
  copy,
  isSelected,
  onToggleCategory,
}: {
  source: ExternalImportSourceStatus;
  copy: ExternalImportCopy;
  isSelected: (sourceId: string, category: ExternalImportCategory) => boolean;
  onToggleCategory: (sourceId: string, category: ExternalImportCategory) => void;
}) {
  return (
    <div className="border-b border-zinc-800 px-3 py-3 last:border-b-0" data-testid={`external-import-source-${source.sourceId}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        <FolderInput className="h-4 w-4 text-zinc-500" />
        {copy.sourceNames[source.sourceId]}
        <span className="font-mono text-[11px] text-zinc-500">{source.homePath}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {IMPORT_CATEGORIES.map((category) => {
          const count = source.categories.find((c) => c.category === category);
          if (!count) return null;
          if (count.readOnly) {
            return (
              <span
                key={category}
                data-testid={`external-import-readonly-${source.sourceId}-${category}`}
                className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[11px] text-zinc-500"
              >
                {categoryLabel(category, copy)} {count.count}{copy.skillsReadOnlySuffix}
              </span>
            );
          }
          const key = `${source.sourceId}#${category}`;
          return (
            <label
              key={category}
              className="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[11px] text-zinc-300"
            >
              <input
                type="checkbox"
                checked={isSelected(source.sourceId, category)}
                onChange={() => onToggleCategory(source.sourceId, category)}
              />
              {categoryLabel(category, copy)} {count.count}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function PreviewStep({
  copy,
  previewMemory,
  previewSkills,
  selectedCandidateIds,
  directiveStates,
  busy,
  onToggleCandidate,
  onConfirmDirective,
  onBack,
  onApply,
}: {
  copy: ExternalImportCopy;
  previewMemory: MemoryImportDryRunResult | null;
  previewSkills: ExternalSkillsPreviewResult | null;
  selectedCandidateIds: Set<string>;
  directiveStates: Record<string, DirectiveState>;
  busy: string | null;
  onToggleCandidate: (candidateId: string, checked: boolean) => void;
  onConfirmDirective: (instructionId: string) => void;
  onBack: () => void;
  onApply: () => void;
}) {
  const readyCandidates = previewMemory?.candidates.filter((candidate) => candidate.disposition === 'add') ?? [];
  const duplicateCandidates = previewMemory?.candidates.filter((candidate) => candidate.disposition === 'skip') ?? [];
  const instructions = previewMemory?.instructions ?? [];
  const skillItems = previewSkills?.items ?? [];
  const hasAnything = readyCandidates.length > 0 || instructions.length > 0 || skillItems.some((item) => item.disposition === 'copy');

  return (
    <div className="space-y-3" data-testid="external-import-preview">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-zinc-200">{copy.previewTitle}</div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={onBack}>
            {copy.backToSelect}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null || !hasAnything}
            leftIcon={busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            onClick={onApply}
          >
            {copy.applyCta}
          </Button>
        </div>
      </div>

      {(previewMemory || skillItems.length > 0) && (
        <div className="max-h-72 space-y-1 overflow-auto rounded-lg border border-zinc-800" data-testid="external-import-preview-memory">
          {readyCandidates.map((candidate) => (
            <label key={candidate.id} className="flex gap-3 border-b border-zinc-800 px-3 py-2 last:border-b-0">
              <input
                type="checkbox"
                checked={selectedCandidateIds.has(candidate.id)}
                onChange={(event) => onToggleCandidate(candidate.id, event.target.checked)}
              />
              <div className="min-w-0">
                <div className="truncate text-xs text-zinc-200">{candidate.entry.title}</div>
                <div className="truncate font-mono text-[11px] text-zinc-500">
                  {candidate.entry.source.importProvenance?.sourceHarness} · {candidate.entry.source.importProvenance?.sourcePath}
                </div>
              </div>
            </label>
          ))}
          {duplicateCandidates.map((candidate) => (
            <div key={candidate.id} className="flex gap-3 border-b border-zinc-800 px-3 py-2 opacity-60 last:border-b-0">
              <span className="text-zinc-600">✓</span>
              <div className="min-w-0">
                <div className="truncate text-xs text-zinc-400">{candidate.entry.title}</div>
                <div className="truncate font-mono text-[11px] text-zinc-600">
                  {candidate.entry.source.importProvenance?.sourceHarness} · {copy.candidateReasonLabels[candidate.reason]}
                </div>
              </div>
            </div>
          ))}
          {readyCandidates.length === 0 && duplicateCandidates.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-zinc-500">{copy.noNewMemories}</div>
          )}
        </div>
      )}

      {skillItems.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3" data-testid="external-import-preview-skills">
          <div className="text-xs font-medium text-zinc-400">
            {copy.skillsSectionTitle.replace('{count}', String(skillItems.length))}
          </div>
          <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
            {skillItems.map((item) => (
              <div key={`${item.sourceId}:${item.name}`} className="truncate font-mono">
                {item.sourceId} · {item.name} · {copy.skillReasonLabels[item.reason]}
              </div>
            ))}
          </div>
        </div>
      )}

      {instructions.length > 0 && (
        <div className="rounded-lg border border-badge-warning/20 bg-badge-warning p-3" data-testid="external-import-instructions">
          <div className="flex items-center gap-2 text-xs font-medium text-badge-warning">
            <ShieldAlert className="h-4 w-4" />
            {copy.instructionsTitle.replace('{count}', String(instructions.length))}
          </div>
          <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
            {instructions.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate font-mono">{item.sourcePath}</div>
                {item.reason !== 'directive-confirmation-required' ? (
                  // instruction-file（如 AGENTS.md/CLAUDE.md）：既有管线定性为只供对照，不给确认钮
                  <span className="shrink-0 text-zinc-500">{copy.instructionCompareOnly}</span>
                ) : directiveStates[item.id] === 'imported' ? (
                  <span className="shrink-0 text-badge-success">{copy.directiveImported}</span>
                ) : directiveStates[item.id] === 'not-imported' ? (
                  <span className="shrink-0 text-zinc-500">{copy.directiveNotImported}</span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    disabled={busy !== null}
                    onClick={() => onConfirmDirective(item.id)}
                  >
                    {busy === `directive:${item.id}`
                      ? copy.confirmingDirective
                      : copy.confirmDirective}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
