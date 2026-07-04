// ============================================================================
// GeneralSettings - Permission Mode + Subagent Inheritance Settings Tab
// ============================================================================
//
// 三个区段：
//   1. 主 Agent 权限模式（default / acceptEdits / bypassPermissions）
//   2. 子 Agent 权限继承策略（strict-inherit / child-narrow / independent）
//   3. 用户级 deny / ask / allow 规则编辑
//
// P6 grandfathering：检测 _legacyPermissions=true 时弹一次性 banner，
// 用户 ack 后写 inheritanceMigrationAcked=true。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle,
  Info,
  ListChecks,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  X,
} from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';
export type InheritanceMode = 'strict-inherit' | 'child-narrow' | 'independent';

export type PermissionRiskLevel = 'low' | 'medium' | 'high';

type GeneralSettingsText = typeof zh.settings.general.permissions;

const DEFAULT_GENERAL_SETTINGS_TEXT = zh.settings.general.permissions;

interface PermissionModeBaseMetadata {
  id: PermissionMode;
  riskLevel: PermissionRiskLevel;
}

export interface PermissionModeRow extends PermissionModeBaseMetadata {
  title: string;
  description: string;
  operationScope: string;
  riskLabel: string;
  selected: boolean;
  actionLabel: string;
}

interface InheritanceModeBaseMetadata {
  id: InheritanceMode;
  recommended?: boolean;
}

export interface InheritanceManagementRow extends InheritanceModeBaseMetadata {
  title: string;
  description: string;
  statusLabel: string;
  exposureLabel: string;
  warning?: string;
  selected: boolean;
  actionLabel: string;
}

export interface PermissionRuleInput {
  denyRules: string;
  askRules: string;
  allowRules: string;
}

export interface PermissionRuleSummary {
  denyCount: number;
  askCount: number;
  allowCount: number;
  totalCount: number;
  highestPriority: string;
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
const INHERITANCE_MODES: InheritanceMode[] = ['strict-inherit', 'child-narrow', 'independent'];

const PERMISSION_MODE_TEXT_KEYS: Record<PermissionMode, keyof GeneralSettingsText['permissionModes']> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
};

const INHERITANCE_MODE_TEXT_KEYS: Record<InheritanceMode, keyof GeneralSettingsText['inheritanceModes']> = {
  'strict-inherit': 'strictInherit',
  'child-narrow': 'childNarrow',
  independent: 'independent',
};

const PERMISSION_MODE_METADATA: PermissionModeBaseMetadata[] = [
  {
    id: 'default',
    riskLevel: 'low',
  },
  {
    id: 'acceptEdits',
    riskLevel: 'medium',
  },
  {
    id: 'bypassPermissions',
    riskLevel: 'high',
  },
];

const INHERITANCE_MODE_METADATA: InheritanceModeBaseMetadata[] = [
  {
    id: 'strict-inherit',
    recommended: true,
  },
  {
    id: 'child-narrow',
  },
  {
    id: 'independent',
  },
];

export function parsePermissionRules(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function buildPermissionModeRows(
  activeMode: PermissionMode,
  text: GeneralSettingsText = DEFAULT_GENERAL_SETTINGS_TEXT,
): PermissionModeRow[] {
  return PERMISSION_MODE_METADATA.map((mode) => ({
    ...mode,
    ...text.permissionModes[PERMISSION_MODE_TEXT_KEYS[mode.id]],
    selected: mode.id === activeMode,
    actionLabel: mode.id === activeMode ? text.currentModeAction : text.switchAction,
  }));
}

export function buildInheritanceRows(
  activeInheritance: InheritanceMode,
  text: GeneralSettingsText = DEFAULT_GENERAL_SETTINGS_TEXT,
): InheritanceManagementRow[] {
  return INHERITANCE_MODE_METADATA.map((mode) => ({
    ...mode,
    ...text.inheritanceModes[INHERITANCE_MODE_TEXT_KEYS[mode.id]],
    selected: mode.id === activeInheritance,
    actionLabel: mode.id === activeInheritance ? text.currentPolicyAction : text.useAction,
  }));
}

export function buildPermissionRuleSummary(
  input: PermissionRuleInput,
  noRulesLabel: string = DEFAULT_GENERAL_SETTINGS_TEXT.noRules,
): PermissionRuleSummary {
  const denyCount = parsePermissionRules(input.denyRules).length;
  const askCount = parsePermissionRules(input.askRules).length;
  const allowCount = parsePermissionRules(input.allowRules).length;

  return {
    denyCount,
    askCount,
    allowCount,
    totalCount: denyCount + askCount + allowCount,
    highestPriority: denyCount > 0 ? 'Deny' : askCount > 0 ? 'Ask' : allowCount > 0 ? 'Allow' : noRulesLabel,
  };
}

function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

function isInheritanceMode(value: string): value is InheritanceMode {
  return INHERITANCE_MODES.includes(value as InheritanceMode);
}

function getPermissionIcon(mode: PermissionMode): React.ReactNode {
  if (mode === 'acceptEdits') return <ShieldAlert className="h-4 w-4" />;
  if (mode === 'bypassPermissions') return <ShieldOff className="h-4 w-4" />;
  return <Shield className="h-4 w-4" />;
}

function getRiskClass(riskLevel: PermissionRiskLevel): string {
  if (riskLevel === 'high') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (riskLevel === 'medium') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getRuleRows(ruleSummary: PermissionRuleSummary, text: GeneralSettingsText) {
  return [
    {
      label: 'Deny',
      caption: text.userRules.denyCaption,
      value: ruleSummary.denyCount,
      color: 'text-red-300',
    },
    {
      label: 'Ask',
      caption: text.userRules.askCaption,
      value: ruleSummary.askCount,
      color: 'text-amber-300',
    },
    {
      label: 'Allow',
      caption: text.userRules.allowCaption,
      value: ruleSummary.allowCount,
      color: 'text-emerald-300',
    },
  ];
}

export const GeneralSettings: React.FC = () => {
  const { t } = useI18n();
  const generalText = t.settings.general.permissions;
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [inheritance, setInheritance] = useState<InheritanceMode>('strict-inherit');
  const [denyRules, setDenyRules] = useState<string>('');
  const [askRules, setAskRules] = useState<string>('');
  const [allowRules, setAllowRules] = useState<string>('');
  const [showMigrationBanner, setShowMigrationBanner] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(true);

  const permissionModeRows = useMemo(
    () => buildPermissionModeRows(permissionMode, generalText),
    [generalText, permissionMode],
  );
  const inheritanceRows = useMemo(
    () => buildInheritanceRows(inheritance, generalText),
    [generalText, inheritance],
  );
  const ruleSummary = useMemo(
    () => buildPermissionRuleSummary({ denyRules, askRules, allowRules }, generalText.noRules),
    [allowRules, askRules, denyRules, generalText.noRules],
  );
  const activeModeRow = permissionModeRows.find((row) => row.selected) ?? permissionModeRows[0];
  const activeInheritanceRow = inheritanceRows.find((row) => row.selected) ?? inheritanceRows[0];

  useEffect(() => {
    const load = async () => {
      try {
        const currentMode = await ipcService.invoke(IPC_CHANNELS.PERMISSION_GET_MODE);
        if (isPermissionMode(currentMode)) {
          setPermissionMode(currentMode);
        }

        const settings = await ipcService.invokeDomain<AppSettings | undefined>(IPC_DOMAINS.SETTINGS, 'get');
        const perms = settings?.permissions;
        if (perms?.inheritance && isInheritanceMode(perms.inheritance)) {
          setInheritance(perms.inheritance);
        }
        if (perms?.deny) setDenyRules(perms.deny.join('\n'));
        if (perms?.ask) setAskRules(perms.ask.join('\n'));
        if (perms?.allow) setAllowRules(perms.allow.join('\n'));

        if (perms?._legacyPermissions && !perms?.inheritanceMigrationAcked) {
          setShowMigrationBanner(true);
        }
      } catch (error) {
        toast.error(generalText.loadFailedPrefix + getErrorMessage(error, generalText.unknownError));
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  const handlePermissionModeChange = async (newMode: PermissionMode) => {
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.PERMISSION_SET_MODE, newMode);
      if (success) {
        setPermissionMode(newMode);
      }
    } catch (error) {
      toast.error(generalText.setModeFailedPrefix + getErrorMessage(error, generalText.unknownError));
    }
  };

  const persistPermissions = async (patch: Partial<AppSettings['permissions']>) => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: patch,
      } as Partial<AppSettings>);
    } catch (error) {
      toast.error(generalText.saveFailedPrefix + getErrorMessage(error, generalText.unknownError));
      throw error;
    }
  };

  const handleInheritanceChange = async (newInheritance: InheritanceMode) => {
    setInheritance(newInheritance);
    await persistPermissions({
      inheritance: newInheritance,
      inheritanceMigrationAcked: true,
    });
    setShowMigrationBanner(false);
    toast.success(generalText.inheritanceSaved);
  };

  const handleRulesBlur = async (kind: 'deny' | 'ask' | 'allow', text: string) => {
    const rules = parsePermissionRules(text);
    await persistPermissions({ [kind]: rules });
    toast.success(`${kind}${generalText.ruleSavedPrefix}${rules.length}${generalText.ruleSavedSuffix}`);
  };

  const handleAckMigration = async () => {
    setShowMigrationBanner(false);
    await persistPermissions({ inheritanceMigrationAcked: true });
  };

  return (
    <SettingsPage
      title={generalText.pageTitle}
      description={generalText.pageDescription}
    >
      <WebModeBanner />

      {showMigrationBanner && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-medium text-blue-300">{generalText.migration.title}</h4>
              <p className="mt-1 text-xs leading-relaxed text-blue-400/80">
                {generalText.migration.description}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAckMigration}
                  disabled={isWebMode()}
                  className="rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-xs text-blue-200 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generalText.migration.acknowledge}
                </button>
                <a
                  href="https://github.com/baochipham942-eng/code-agent/releases/latest"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-400 underline hover:text-blue-300"
                >
                  {generalText.migration.releaseNotes}
                </a>
              </div>
            </div>
            <button
              type="button"
              onClick={handleAckMigration}
              disabled={isWebMode()}
              className="text-blue-300/60 hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t.common.close}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <SettingsSection
        title={generalText.controlPlane.title}
        description={generalText.controlPlane.description}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              [generalText.controlPlane.summaryCurrentMode, activeModeRow.title, activeModeRow.operationScope],
              [generalText.controlPlane.summaryRiskLevel, activeModeRow.riskLabel, activeModeRow.description],
              [generalText.controlPlane.summarySubAgent, activeInheritanceRow.title, activeInheritanceRow.exposureLabel],
              [
                generalText.controlPlane.summaryUserRules,
                String(ruleSummary.totalCount),
                `${generalText.highestPriorityPrefix}${ruleSummary.highestPriority}`,
              ],
            ].map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={caption}>
                  {caption}
                </div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{generalText.controlPlane.mainAgentMode}</th>
                  <th className="px-3 py-2 font-medium">{generalText.controlPlane.status}</th>
                  <th className="px-3 py-2 font-medium">{generalText.controlPlane.permissionBehavior}</th>
                  <th className="px-3 py-2 font-medium">{generalText.controlPlane.risk}</th>
                  <th className="px-3 py-2 text-right font-medium">{generalText.controlPlane.action}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">{t.common.loading}</td>
                  </tr>
                ) : (
                  permissionModeRows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.selected ? 'bg-blue-500/10' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
                    >
                      <td className="px-3 py-3 align-middle">
                        <div className="flex items-start gap-2">
                          <span className={`rounded border p-1.5 ${getRiskClass(row.riskLevel)}`}>
                            {getPermissionIcon(row.id)}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-200">{row.title}</div>
                            <div className="mt-1 max-w-[340px] text-zinc-500">{row.description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        {row.selected ? (
                          <span className="inline-flex items-center gap-1 rounded border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-blue-300">
                            <CheckCircle className="h-3 w-3" />
                            {generalText.controlPlane.currentEnabled}
                          </span>
                        ) : (
                          <span className="inline-flex rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                            {generalText.controlPlane.switchable}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-middle text-zinc-300">{row.operationScope}</td>
                      <td className="px-3 py-3 align-middle">
                        <span className={`inline-flex rounded border px-2 py-1 ${getRiskClass(row.riskLevel)}`}>
                          {row.riskLabel}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={isWebMode() || row.selected}
                            onClick={() => handlePermissionModeChange(row.id)}
                            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {row.actionLabel}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {permissionMode === 'bypassPermissions' && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
            <div className="flex items-start gap-2">
              <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <div>
                <h4 className="text-sm font-medium text-red-300">{generalText.bypassWarning.title}</h4>
                <p className="mt-1 text-xs text-red-400/70">
                  {generalText.bypassWarning.description}
                </p>
              </div>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={generalText.inheritanceSection.title}
        description={generalText.inheritanceSection.description}
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{generalText.inheritanceSection.strategy}</th>
                  <th className="px-3 py-2 font-medium">{generalText.inheritanceSection.status}</th>
                  <th className="px-3 py-2 font-medium">{generalText.inheritanceSection.exposure}</th>
                  <th className="px-3 py-2 text-right font-medium">{generalText.inheritanceSection.action}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">{t.common.loading}</td>
                  </tr>
                ) : (
                  inheritanceRows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.selected ? 'bg-zinc-800/70' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
                    >
                      <td className="px-3 py-3 align-top">
                        <div className="flex items-start gap-2">
                          <span className="rounded border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300">
                            <Bot className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-zinc-200">{row.title}</span>
                              {row.recommended ? (
                                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-300">
                                  {generalText.inheritanceSection.recommended}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 max-w-[420px] text-zinc-500">{row.description}</div>
                            {row.warning ? (
                              <div className="mt-1 flex items-center gap-1 text-amber-300/90">
                                <AlertTriangle className="h-3 w-3" />
                                <span>{row.warning}</span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span className={`inline-flex rounded border px-2 py-1 ${
                          row.selected
                            ? 'border-zinc-500 bg-zinc-800 text-zinc-200'
                            : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                        }`}
                        >
                          {row.selected ? generalText.currentPolicyAction : row.statusLabel}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top text-zinc-300">{row.exposureLabel}</td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={isWebMode() || row.selected}
                            onClick={() => handleInheritanceChange(row.id)}
                            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {row.actionLabel}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>

      <SettingsDetails
        title={generalText.userRules.title}
        description={generalText.userRules.description}
        defaultOpen={ruleSummary.totalCount > 0}
        actions={(
          <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
            <ListChecks className="h-3 w-3" />
            {ruleSummary.totalCount}{generalText.ruleCountSuffix}
          </span>
        )}
      >
        {isLoading ? (
          <div className="text-xs text-zinc-500">{t.common.loading}</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {getRuleRows(ruleSummary, generalText).map((row) => (
                <div key={row.label} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                  <div className={`text-sm font-medium ${row.color}`}>{row.label}</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">{row.value}</div>
                  <div className="text-[11px] text-zinc-500">{row.caption}</div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-500">
              {generalText.userRules.examplePrefix}
              <code className="mx-1 rounded bg-zinc-800 px-1 py-0.5 text-[11px] text-zinc-300">Bash(rm -rf *)</code>
              <code className="mx-1 rounded bg-zinc-800 px-1 py-0.5 text-[11px] text-zinc-300">Write(/etc/*)</code>
              {generalText.userRules.autoSaveHint}
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="mb-1 block text-xs text-red-300">{generalText.userRules.denyLabel}</label>
                <textarea
                  value={denyRules}
                  onChange={(event) => setDenyRules(event.target.value)}
                  onBlur={(event) => handleRulesBlur('deny', event.target.value)}
                  disabled={isWebMode()}
                  placeholder={'Bash(rm -rf *)\nWrite(/etc/*)\nNetwork(*)'}
                  rows={4}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-hidden focus:border-red-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-amber-300">{generalText.userRules.askLabel}</label>
                <textarea
                  value={askRules}
                  onChange={(event) => setAskRules(event.target.value)}
                  onBlur={(event) => handleRulesBlur('ask', event.target.value)}
                  disabled={isWebMode()}
                  placeholder={'Bash(git push *)\nWrite(*.env)'}
                  rows={3}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-hidden focus:border-amber-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-emerald-300">{generalText.userRules.allowLabel}</label>
                <textarea
                  value={allowRules}
                  onChange={(event) => setAllowRules(event.target.value)}
                  onBlur={(event) => handleRulesBlur('allow', event.target.value)}
                  disabled={isWebMode()}
                  placeholder={'Read(*)\nBash(ls *)\nBash(git status)'}
                  rows={3}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-hidden focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </div>
          </div>
        )}
      </SettingsDetails>

      <SettingsDetails
        title={generalText.semantics.title}
        description={generalText.semantics.description}
      >
        <div className="grid grid-cols-1 gap-3 text-xs text-zinc-400 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
            <div className="mb-1 flex items-center gap-2 text-zinc-200">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              {generalText.semantics.priorityTitle}
            </div>
            <p>{generalText.semantics.priorityDescription}</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
            <div className="mb-1 flex items-center gap-2 text-zinc-200">
              <Bot className="h-4 w-4 text-blue-300" />
              {generalText.semantics.boundaryTitle}
            </div>
            <p>{generalText.semantics.boundaryDescription}</p>
          </div>
        </div>
      </SettingsDetails>
    </SettingsPage>
  );
};
