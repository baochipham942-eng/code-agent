// ============================================================================
// AgentEngineListSection — 设置页「执行引擎」section
// ----------------------------------------------------------------------------
// 展示完整 engine manifest 探测来源（与 onboarding 同源 listSources），包括
// 没有正式 kind/adapter 的 Qoder Work / Comate·Zulu / Cursor CLI。
//
// 数据：
//   - 初始加载：AGENT_ENGINE listSources（完整来源）+ list（正式 descriptor 配对）
//   - 「检测引擎」：先 detect 强制刷新，再 listSources；推荐项绝不伪装成已安装
//   - 有 kind 且能配对 AgentEngineDescriptor 的来源可会话切换
//   - 无 kind / 无 descriptor 的来源只展示真实 detected/authState/evidence/recommendation
//
// 凭证归官方客户端；本 UI 不展示 auditNotes / 密钥等秘密。
// 状态派生走 contract 字段，禁止按产品名写分支。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, RefreshCw, Terminal } from 'lucide-react';
import type { AppSettings } from '@shared/contract';
import type {
  AgentEngineDescriptor,
  AgentEngineSourceDescriptor,
} from '@shared/contract/agentEngine';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { Badge, Button } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';
import {
  buildModelSwitcherEngineSelection,
  EngineBillingBadge,
  getEngineUnavailableReason,
} from '../../../StatusBar/modelSwitcherHelpers';
import { buildEngineSectionRowsFromSources } from './agentEngineSectionHelpers';

const logger = createLogger('AgentEngineListSection');

export const AgentEngineListSection: React.FC = () => {
  const { t } = useI18n();
  const section = t.engineCompat.engineSection;
  const [sources, setSources] = useState<AgentEngineSourceDescriptor[] | null>(null);
  const [descriptors, setDescriptors] = useState<AgentEngineDescriptor[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [switchingEngine, setSwitchingEngine] = useState<string | null>(null);
  const [engineDefaultModels, setEngineDefaultModels] = useState<AppSettings['models']['agentEngines']>({});
  const currentSession = useSessionStore((state) =>
    state.currentSessionId
      ? state.sessions.find((session) => session.id === state.currentSessionId) ?? null
      : null
  );
  const updateSessionEngine = useSessionStore((state) => state.updateSessionEngine);
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const currentSessionId = currentSession?.id ?? null;
  const currentEngineKind = currentSession?.engine?.kind ?? 'native';
  const effectiveWorkingDirectory = currentSession?.workingDirectory ?? appWorkingDirectory;

  const applyEnginePayload = useCallback((
    nextSources: AgentEngineSourceDescriptor[] | unknown,
    nextDescriptors: AgentEngineDescriptor[] | unknown,
  ) => {
    setSources(Array.isArray(nextSources) ? nextSources : []);
    setDescriptors(Array.isArray(nextDescriptors) ? nextDescriptors : []);
  }, []);

  /**
   * 「检测引擎」：必须先 detect（invalidate 强制重探），再 listSources。
   * detect 返回的是正式 list，不能单独当完整来源；推荐项只出现在 listSources。
   */
  const detectEngines = useCallback(async () => {
    setDetecting(true);
    try {
      const descriptorList = await ipcService.invokeDomain<AgentEngineDescriptor[]>(
        IPC_DOMAINS.AGENT_ENGINE,
        'detect',
      );
      const sourceList = await ipcService.invokeDomain<AgentEngineSourceDescriptor[]>(
        IPC_DOMAINS.AGENT_ENGINE,
        'listSources',
      );
      applyEnginePayload(sourceList, descriptorList);
    } catch (error) {
      logger.warn('Failed to detect agent engines', {
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(section.detectFailed);
    } finally {
      setDetecting(false);
    }
  }, [applyEnginePayload, section.detectFailed]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sourceList, descriptorList] = await Promise.all([
          ipcService.invokeDomain<AgentEngineSourceDescriptor[]>(
            IPC_DOMAINS.AGENT_ENGINE,
            'listSources',
          ),
          ipcService.invokeDomain<AgentEngineDescriptor[]>(
            IPC_DOMAINS.AGENT_ENGINE,
            'list',
          ),
        ]);
        if (!cancelled) applyEnginePayload(sourceList, descriptorList);
      } catch (error) {
        logger.warn('Failed to load agent engine sources', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) applyEnginePayload([], []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyEnginePayload]);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (!cancelled) setEngineDefaultModels(settings?.models?.agentEngines ?? {});
      })
      .catch((error: unknown) => {
        logger.warn('Failed to load Agent Engine default models', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) setEngineDefaultModels({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = sources ? buildEngineSectionRowsFromSources(sources, descriptors, t) : [];
  const descriptorByKind = useMemo(
    () => new Map(descriptors.map((descriptor) => [descriptor.kind, descriptor])),
    [descriptors],
  );

  const handleUseEngine = useCallback(async (descriptor: AgentEngineDescriptor) => {
    if (!currentSessionId) {
      toast.info(section.noSessionHint);
      return;
    }
    const unavailableReason = getEngineUnavailableReason(
      descriptor,
      descriptor.kind !== 'native' && !effectiveWorkingDirectory,
    );
    if (unavailableReason) {
      toast.info(unavailableReason);
      return;
    }
    setSwitchingEngine(descriptor.kind);
    try {
      await updateSessionEngine(
        currentSessionId,
        buildModelSwitcherEngineSelection(
          descriptor,
          effectiveWorkingDirectory,
          descriptor.kind === 'native'
            ? undefined
            : engineDefaultModels?.[descriptor.kind]?.defaultModel,
        ),
      );
      toast.success(section.engineSelected.replace('{engine}', descriptor.label));
    } catch (error) {
      toast.error(section.engineSelectFailed.replace(
        '{error}',
        error instanceof Error ? error.message : section.unknownError,
      ));
    } finally {
      setSwitchingEngine(null);
    }
  }, [currentSessionId, effectiveWorkingDirectory, engineDefaultModels, section, updateSessionEngine]);

  return (
    <SettingsSection
      title={section.title}
      description={section.description}
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void detectEngines()}
          disabled={detecting}
          data-testid="engine-detect-button"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${detecting ? 'animate-spin' : ''}`} />
          {detecting ? section.detecting : section.detectButton}
        </Button>
      }
    >
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
        {sources === null ? (
          <div className="px-3 py-4 text-sm text-zinc-500">{section.loading}</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-4 text-sm text-zinc-500">{section.empty}</div>
        ) : (
          <div className="divide-y divide-zinc-800/80">
            {rows.map((row) => {
              const descriptor = row.kind ? descriptorByKind.get(row.kind) : undefined;
              const selected = Boolean(row.kind && row.kind === currentEngineKind);
              const unavailableReason = descriptor
                ? getEngineUnavailableReason(
                  descriptor,
                  descriptor.kind !== 'native' && !effectiveWorkingDirectory,
                )
                : row.switchable
                  ? section.unavailableHint
                  : row.isRecommendationOnly
                    ? section.recommendationOnlyHint
                    : section.notSwitchableHint;
              const disabled = isWebMode()
                || !row.switchable
                || !descriptor
                || selected
                || Boolean(unavailableReason)
                || switchingEngine !== null;
              return (
                <div
                  key={row.manifestId}
                  className="px-3 py-3"
                  data-engine-manifest={row.manifestId}
                  data-engine-kind={row.kind ?? ''}
                  data-engine-switchable={row.switchable ? 'true' : 'false'}
                  data-engine-source-status={row.statusKey}
                  data-engine-recommendation-only={row.isRecommendationOnly ? 'true' : 'false'}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {row.kind === 'native' ? (
                      <Cpu className="h-4 w-4 shrink-0 text-zinc-400" />
                    ) : (
                      <Terminal className="h-4 w-4 shrink-0 text-zinc-400" />
                    )}
                    <span className="text-sm font-medium text-zinc-100">{row.label}</span>
                    {/* 正式引擎优先展示 installState；探测-only 只展示 contract 状态徽标。 */}
                    {row.installState && row.installStateLabel ? (
                      <Badge
                        className={`text-[11px] ${row.installStateBadgeClass ?? ''}`}
                        data-engine-install-state={row.installState}
                      >
                        {row.installStateLabel}
                      </Badge>
                    ) : (
                      <Badge
                        className={`text-[11px] ${row.statusBadgeClass}`}
                        data-engine-source-status-badge={row.statusKey}
                      >
                        {row.statusLabel}
                      </Badge>
                    )}
                    {/* 次级状态：如「已检测」旁的「需要登录」；正式引擎有 install 徽标时也展示。 */}
                    {row.secondaryStatusLabel ? (
                      <Badge
                        className={`text-[11px] ${row.secondaryStatusBadgeClass ?? ''}`}
                        data-engine-source-status-secondary
                      >
                        {row.secondaryStatusLabel}
                      </Badge>
                    ) : row.installState && row.statusKey !== 'available' && row.statusKey !== 'not_installed' ? (
                      <Badge
                        className={`text-[11px] ${row.statusBadgeClass}`}
                        data-engine-source-status-badge={row.statusKey}
                      >
                        {row.statusLabel}
                      </Badge>
                    ) : null}
                    {row.billing ? <EngineBillingBadge summary={row.billing} /> : null}
                    <Button
                      size="sm"
                      variant={selected ? 'ghost' : 'secondary'}
                      onClick={() => descriptor ? void handleUseEngine(descriptor) : undefined}
                      disabled={disabled}
                      className="ml-auto min-w-[7rem]"
                      data-testid={`engine-switch-button-${row.manifestId}`}
                      title={
                        selected
                          ? section.currentEngineTitle
                          : unavailableReason || section.switchToEngine
                      }
                    >
                      {selected
                        ? section.currentEngine
                        : switchingEngine === row.kind
                          ? section.switchingEngine
                          : section.switchToEngine}
                    </Button>
                  </div>

                  <p className="mt-1.5 text-xs text-zinc-500">{row.summary}</p>
                  <p
                    className="mt-1 text-[11px] text-zinc-400"
                    data-engine-status-detail={row.manifestId}
                  >
                    {row.statusDetail}
                  </p>

                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                    {row.version ? (
                      <div className="flex gap-1.5">
                        <dt className="shrink-0 text-zinc-500">{section.versionLabel}</dt>
                        <dd className="truncate font-mono text-zinc-300" title={row.version}>{row.version}</dd>
                      </div>
                    ) : null}
                    {row.binaryPath ? (
                      <div className="flex gap-1.5">
                        <dt className="shrink-0 text-zinc-500">{section.binaryPathLabel}</dt>
                        <dd className="truncate font-mono text-zinc-400" title={row.binaryPath}>{row.binaryPath}</dd>
                      </div>
                    ) : null}
                    {row.defaultModelHint ? (
                      <div className="flex gap-1.5 sm:col-span-2">
                        <dt className="shrink-0 text-zinc-500">{section.defaultModelLabel}</dt>
                        <dd className="text-zinc-400">{row.defaultModelHint}</dd>
                      </div>
                    ) : null}
                  </dl>

                  {row.installHint ? (
                    <div className="mt-2 rounded border border-badge-warning/20 bg-amber-500/[0.06] px-2 py-1.5 text-[11px] text-badge-warning">
                      <span className="font-medium">{section.installHintTitle}：</span>
                      {row.installHint}
                    </div>
                  ) : null}
                  {row.loginHint ? (
                    <div className="mt-1.5 text-[11px] text-zinc-500">
                      <span className="font-medium text-zinc-400">{section.loginHintTitle}：</span>
                      {row.loginHint}
                    </div>
                  ) : null}
                  {/* 凭证归官方客户端：只提示归属，不展示密钥或 auditNotes。 */}
                  {!row.kind || row.kind !== 'native' ? (
                    <div className="mt-1.5 text-[11px] text-zinc-600">
                      {section.credentialOwnerOfficial}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SettingsSection>
  );
};
