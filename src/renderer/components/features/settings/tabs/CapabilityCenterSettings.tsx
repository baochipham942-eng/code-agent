// ============================================================================
// CapabilityCenterSettings - local capability inventory and audit surface
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileCog,
  Filter,
  Loader2,
  PackageCheck,
  Plug,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Terminal,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wrench,
  Workflow,
  X,
} from 'lucide-react';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { Button, Input, type ButtonVariant } from '../../../primitives';
import { useCapabilityInventory } from '../../../../hooks/useCapabilityInventory';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import type { SettingsTab } from '../../../../utils/settingsTabs';
import type {
  CapabilityCenterDiagnostic,
  CapabilityCenterItem,
  CapabilityKind,
  CapabilityRequirement,
  CapabilityRiskTier,
  CapabilityRuntimeState,
  CapabilitySourceKind,
} from '@shared/contract/capability';

type CapabilityCenterText = typeof zh.settings.capabilities;
const DEFAULT_CAPABILITY_CENTER_TEXT = zh.settings.capabilities;

const KIND_FILTERS: Array<'all' | CapabilityKind> = [
  'all',
  'agent_engine',
  'skill',
  'mcp_template',
  'tool_bundle',
  'connector',
  'channel_adapter',
  'workflow_recipe',
];

type SourceFilter = 'all' | CapabilitySourceKind;
type HealthFilter = 'all' | 'ready' | 'needs_config' | 'disabled' | 'error';

const SOURCE_FILTERS: SourceFilter[] = [
  'all',
  'curated',
  'builtin',
  'project',
  'user',
  'library',
  'runtime',
  'memory',
  'cloud',
  'team',
  'local',
  'marketplace',
  'remote',
  'plugin',
];
const HEALTH_FILTERS: HealthFilter[] = ['all', 'ready', 'needs_config', 'disabled', 'error'];

function kindIcon(kind: CapabilityKind): React.ReactNode {
  switch (kind) {
    case 'agent_engine':
      return <Terminal className="h-4 w-4 text-emerald-300" />;
    case 'skill':
      return <Sparkles className="h-4 w-4 text-amber-300" />;
    case 'mcp_template':
      return <Plug className="h-4 w-4 text-sky-300" />;
    case 'tool_bundle':
      return <Wrench className="h-4 w-4 text-violet-300" />;
    case 'channel_adapter':
      return <FileCog className="h-4 w-4 text-emerald-300" />;
    case 'workflow_recipe':
      return <Workflow className="h-4 w-4 text-cyan-300" />;
    case 'connector':
      return <PackageCheck className="h-4 w-4 text-orange-300" />;
    default:
      return <PackageCheck className="h-4 w-4 text-zinc-300" />;
  }
}

function getRiskClass(risk: CapabilityRiskTier): string {
  switch (risk) {
    case 'high':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'medium':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    default:
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  }
}

function getRuntimeClass(runtime: CapabilityRuntimeState): string {
  switch (runtime) {
    case 'ready':
    case 'connected':
      return 'text-emerald-300';
    case 'lazy':
    case 'unknown':
      return 'text-sky-300';
    case 'blocked':
    case 'error':
      return 'text-red-300';
    default:
      return 'text-zinc-400';
  }
}

function getHealthFilterLabel(
  filter: HealthFilter,
  labels: CapabilityCenterText['healthFilters'],
): string {
  return labels[filter];
}

function getSourceFilterLabel(
  filter: SourceFilter,
  sourceLabels: Partial<Record<CapabilitySourceKind, string>>,
  allLabel: string,
): string {
  return filter === 'all' ? allLabel : sourceLabels[filter] || filter;
}

function matchesHealth(item: CapabilityCenterItem, filter: HealthFilter): boolean {
  switch (filter) {
    case 'ready':
      return item.state.runtime === 'ready' || item.state.runtime === 'connected' || item.state.runtime === 'lazy';
    case 'needs_config':
      return item.state.runtime === 'not_configured' || item.config.some((req) => req.status === 'missing');
    case 'disabled':
      return item.state.enable === 'disabled';
    case 'error':
      return item.state.runtime === 'error' || item.state.runtime === 'blocked';
    default:
      return true;
  }
}

function matchesSource(item: CapabilityCenterItem, filter: SourceFilter): boolean {
  return filter === 'all' || item.source.kind === filter;
}

function matchQuery(item: CapabilityCenterItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.name,
    item.summary,
    item.description,
    item.source.label,
    item.source.path,
    item.source.url,
    item.source.author,
    item.source.reviewedAt,
    item.source.contentHash,
    item.source.registryFileHash,
    item.assessment?.priority,
    item.assessment?.portability,
    item.assessment?.recommendedUse,
    ...item.tags,
    ...(item.assessment?.evidenceRefs || []),
    ...item.permissions.map((permission) => permission.label),
    ...item.config.map((req) => req.label),
    ...item.dependencies.map((req) => req.label),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

function missingRequirements(requirements: CapabilityRequirement[]): CapabilityRequirement[] {
  return requirements.filter((requirement) => requirement.status === 'missing');
}

interface CapabilityActionPresentation {
  label: string;
  variant: ButtonVariant;
  disabled: boolean;
  title?: string;
  leftIcon?: React.ReactNode;
  nextEnabled: boolean | null;
  settingsTab: SettingsTab | null;
  installDraft: boolean;
  removeDraft: boolean;
}

function getCapabilitySettingsTab(item: CapabilityCenterItem): SettingsTab | null {
  switch (item.kind) {
    case 'mcp_template':
    case 'connector':
      return 'mcp';
    case 'channel_adapter':
      return 'channels';
    case 'skill':
      return 'skills';
    default:
      return null;
  }
}

function getSettingsActionLabel(
  item: CapabilityCenterItem,
  labels: CapabilityCenterText['actions'],
): string {
  return item.state.install === 'available' || item.state.runtime === 'not_configured'
    ? labels.configure
    : labels.manage;
}

function getCapabilityActionPresentation(
  item: CapabilityCenterItem,
  canNavigateSettings: boolean,
  labels: CapabilityCenterText['actions'],
): CapabilityActionPresentation {
  if (item.actions.canRemoveDraft) {
    return {
      label: labels.removeDraft,
      variant: 'ghost',
      disabled: false,
      title: item.actions.reason,
      leftIcon: <Trash2 className="h-3.5 w-3.5" />,
      nextEnabled: null,
      settingsTab: null,
      installDraft: false,
      removeDraft: true,
    };
  }

  if (item.installPlan && item.state.install === 'available') {
    if (item.actions.canInstallDraft) {
      return {
        label: labels.generateDraft,
        variant: 'secondary',
        disabled: false,
        title: item.installPlan.summary,
        leftIcon: <PackageCheck className="h-3.5 w-3.5" />,
        nextEnabled: null,
        settingsTab: null,
        installDraft: true,
        removeDraft: false,
      };
    }
    return {
      label: labels.installPreview,
      variant: 'secondary',
      disabled: true,
      title: item.actions.reason || item.installPlan.summary,
      leftIcon: <PackageCheck className="h-3.5 w-3.5" />,
      nextEnabled: null,
      settingsTab: null,
      installDraft: false,
      removeDraft: false,
    };
  }

  if (item.state.enable === 'not_applicable') {
    const settingsTab = getCapabilitySettingsTab(item);
    return {
      label: settingsTab ? getSettingsActionLabel(item, labels) : labels.readOnly,
      variant: 'ghost',
      disabled: !settingsTab || !canNavigateSettings,
      title: item.actions.reason,
      leftIcon: <FileCog className="h-3.5 w-3.5" />,
      nextEnabled: null,
      settingsTab,
      installDraft: false,
      removeDraft: false,
    };
  }

  const isEnabled = item.state.enable === 'enabled';
  const canToggle = isEnabled ? item.actions.canDisable : item.actions.canEnable;
  if (!canToggle) {
    const settingsTab = getCapabilitySettingsTab(item);
    return {
      label: settingsTab ? getSettingsActionLabel(item, labels) : labels.readOnly,
      variant: 'ghost',
      disabled: !settingsTab || !canNavigateSettings,
      title: item.actions.reason,
      leftIcon: <FileCog className="h-3.5 w-3.5" />,
      nextEnabled: null,
      settingsTab,
      installDraft: false,
      removeDraft: false,
    };
  }

  return {
    label: isEnabled ? labels.disable : labels.enable,
    variant: isEnabled ? 'ghost' : 'secondary',
    disabled: false,
    title: undefined,
    leftIcon: isEnabled ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />,
    nextEnabled: !isEnabled,
    settingsTab: null,
    installDraft: false,
    removeDraft: false,
  };
}

interface CapabilityCardProps {
  item: CapabilityCenterItem;
  text: CapabilityCenterText;
  actionLoading: boolean;
  onToggle: (item: CapabilityCenterItem, enabled: boolean) => void;
  onInstallDraft: (item: CapabilityCenterItem, inputs?: Record<string, string>) => void;
  onRemoveDraft: (item: CapabilityCenterItem) => void;
  onNavigateSettings?: (tab: SettingsTab) => void;
}

const CapabilityCard: React.FC<CapabilityCardProps> = ({ item, text, actionLoading, onToggle, onInstallDraft, onRemoveDraft, onNavigateSettings }) => {
  const draftParameters = item.installPlan?.draft?.parameters || [];
  const [draftInputs, setDraftInputs] = useState<Record<string, string>>({});
  const missingDraftParameters = draftParameters.filter((parameter) => {
    return parameter.required && !draftInputs[parameter.key]?.trim();
  });
  const draftParameterKeyByLabel = new Map(draftParameters.map((parameter) => [parameter.label, parameter.key]));
  const missingConfig = missingRequirements([...item.config, ...item.dependencies]).filter((requirement) => {
    const draftKey = draftParameterKeyByLabel.get(requirement.label);
    return !draftKey || !draftInputs[draftKey]?.trim();
  });
  const action = getCapabilityActionPresentation(item, Boolean(onNavigateSettings), text.actions);
  const draftSettingsTab = item.actions.canRemoveDraft ? getCapabilitySettingsTab(item) : null;
  const showDraftManageAction = Boolean(draftSettingsTab && onNavigateSettings);
  const actionDisabled = action.disabled || (action.installDraft && missingDraftParameters.length > 0);
  const actionTitle = action.installDraft && missingDraftParameters.length > 0
    ? `${text.missingPrefix}${missingDraftParameters.map((parameter) => parameter.label).join(', ')}`
    : action.title;
  const agentEngineBadges = formatAgentEngineBadges(item, text.agentEngineBadges);
  const assessment = item.assessment;

  return (
    <article className="rounded-lg border border-zinc-700 bg-zinc-800/80 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
            {kindIcon(item.kind)}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="truncate text-sm font-medium text-zinc-100">{item.name}</h4>
              <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-[11px] text-zinc-400">
                {text.kindLabels[item.kind]}
              </span>
              <span className={`rounded border px-1.5 py-0.5 text-[11px] ${getRiskClass(item.risk.tier)}`}>
                {item.risk.tier}
              </span>
              {assessment ? (
                <>
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] ${getAssessmentPriorityClass(assessment.priority)}`}>
                    {assessment.priority}
                  </span>
                  <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-200">
                    {formatAssessmentPortability(assessment.portability, text.assessmentPortability)}
                  </span>
                </>
              ) : null}
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">{item.summary}</p>
            {assessment ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-300">
                {assessment.recommendedUse}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className={getRuntimeClass(item.state.runtime)}>
                {text.runtimeLabels[item.state.runtime]}
              </span>
              <span className="text-zinc-500">{item.source.label}</span>
              {item.source.version ? <span className="text-zinc-500">{item.source.version}</span> : null}
              {item.state.statusLabel ? <span className="text-zinc-500">{item.state.statusLabel}</span> : null}
              {item.metrics?.tools !== undefined ? <span className="text-zinc-500">{item.metrics.tools} tools</span> : null}
              {item.metrics?.accounts !== undefined ? <span className="text-zinc-500">{item.metrics.accounts} account</span> : null}
            </div>
            {item.state.runtime === 'blocked' && item.actions.reason ? (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{item.actions.reason}</span>
              </div>
            ) : null}
            {agentEngineBadges.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {agentEngineBadges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {showDraftManageAction ? (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<FileCog className="h-3.5 w-3.5" />}
              onClick={() => {
                if (draftSettingsTab) {
                  onNavigateSettings?.(draftSettingsTab);
                }
              }}
            >
              {text.actions.manage}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={action.variant}
            loading={actionLoading}
            disabled={actionDisabled}
            title={actionTitle}
            leftIcon={action.leftIcon}
            onClick={() => {
              if (action.settingsTab) {
                onNavigateSettings?.(action.settingsTab);
              } else if (action.installDraft) {
                onInstallDraft(item, draftInputs);
              } else if (action.removeDraft) {
                onRemoveDraft(item);
              } else if (action.nextEnabled !== null) {
                onToggle(item, action.nextEnabled);
              }
            }}
          >
            {action.label}
          </Button>
        </div>
      </div>

      {draftParameters.length > 0 && item.actions.canInstallDraft ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3 sm:grid-cols-2">
          {draftParameters.map((parameter) => (
            <label key={parameter.key} className="min-w-0 text-xs">
              <span className="mb-1 block text-[11px] font-medium text-zinc-500">
                {parameter.label}
              </span>
              <Input
                value={draftInputs[parameter.key] || ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraftInputs((current) => ({
                    ...current,
                    [parameter.key]: value,
                  }));
                }}
                placeholder={parameter.kind === 'path' ? '/path/to/folder' : parameter.key}
                inputSize="sm"
              />
            </label>
          ))}
        </div>
      ) : null}

      {(missingConfig.length > 0 || item.state.error) && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            {item.state.error ? <div className="truncate">{item.state.error}</div> : null}
            {missingConfig.length > 0 ? (
              <div className="truncate">
                {text.missingPrefix}{missingConfig.map((req) => req.label).join(', ')}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <details className="group mt-3 rounded-lg border border-zinc-700/60 bg-zinc-900/40">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs text-zinc-400">
          <span>{text.detail.summaryTitle}</span>
          <span className="text-zinc-500 group-open:hidden">{text.detail.expand}</span>
          <span className="hidden text-zinc-500 group-open:inline">{text.detail.collapse}</span>
        </summary>
        <div className="space-y-3 border-t border-zinc-700/60 px-3 py-3 text-xs">
          {item.installPlan ? <InfoBlock title={text.actions.installPreview} values={formatInstallPlan(item)} empty={text.detail.empty} /> : null}
          {item.kind === 'agent_engine' ? <InfoBlock title={text.detail.inspectionStatus} values={formatAgentEngineInspection(item)} empty={text.detail.empty} /> : null}
          {item.assessment ? <InfoBlock title={text.detail.assessment} values={formatAssessment(item, text)} empty={text.detail.empty} /> : null}
          <InfoBlock title={text.detail.permissions} values={item.permissions.map((entry) => `${entry.label}${entry.detail ? ` · ${entry.detail}` : ''}`)} empty={text.detail.empty} />
          <InfoBlock title={text.detail.risk} values={item.risk.reasons} empty={text.detail.empty} />
          <InfoBlock title={text.detail.config} values={item.config.map(formatRequirement)} empty={text.detail.noConfigItems} />
          <InfoBlock title={text.detail.dependencies} values={item.dependencies.map(formatRequirement)} empty={text.detail.noDependencies} />
          <InfoBlock title={text.detail.source} values={formatSource(item)} empty={text.detail.empty} />
          <InfoBlock title={text.detail.audit} values={formatAudit(item)} empty={text.detail.noAuditRecords} />
        </div>
      </details>
    </article>
  );
};

interface InfoBlockProps {
  title: string;
  values: string[];
  empty?: string;
}

const InfoBlock: React.FC<InfoBlockProps> = ({ title, values, empty = DEFAULT_CAPABILITY_CENTER_TEXT.detail.empty }) => (
  <div>
    <div className="mb-1 text-[11px] font-medium text-zinc-500">{title}</div>
    <div className="space-y-1 text-zinc-300">
      {(values.length > 0 ? values : [empty]).map((value) => (
        <div key={value} className="break-words leading-relaxed">{value}</div>
      ))}
    </div>
  </div>
);

function formatRequirement(requirement: CapabilityRequirement): string {
  const prefix = requirement.sensitive ? '[secret]' : `[${requirement.kind}]`;
  const value = requirement.value ? ` · ${requirement.value}` : '';
  return `${prefix} ${requirement.label}: ${requirement.status}${value}`;
}

function findRequirementValue(item: CapabilityCenterItem, label: string): string | undefined {
  return [...item.config, ...item.dependencies].find((requirement) => requirement.label === label)?.value;
}

function formatAgentEngineBadges(
  item: CapabilityCenterItem,
  text: CapabilityCenterText['agentEngineBadges'] = DEFAULT_CAPABILITY_CENTER_TEXT.agentEngineBadges,
): string[] {
  if (item.kind !== 'agent_engine') return [];
  const launchMode = findRequirementValue(item, 'Launch mode');
  const permissionProfile = findRequirementValue(item, 'Permission profile');
  const workspacePolicy = findRequirementValue(item, 'Workspace policy');
  const launchBadge = launchMode
    ? launchMode === 'external CLI' ? text.externalCli : text.builtinRuntime
    : undefined;
  return [
    launchBadge,
    permissionProfile === 'read_only' ? text.readOnlyDefault : permissionProfile,
    workspacePolicy === 'current workspace only' ? text.currentWorkspace : workspacePolicy,
  ].filter((value): value is string => Boolean(value));
}

function formatAgentEngineInspection(item: CapabilityCenterItem): string[] {
  return [
    `install: ${item.state.install}`,
    `runtime: ${item.state.runtime}`,
    item.state.statusLabel ? `status: ${item.state.statusLabel}` : undefined,
    item.source.version ? `version ${item.source.version}` : undefined,
    item.source.path ? `binary ${item.source.path}` : undefined,
    findRequirementValue(item, 'Launch mode') ? `launch ${findRequirementValue(item, 'Launch mode')}` : undefined,
    findRequirementValue(item, 'Permission profile') ? `permission ${findRequirementValue(item, 'Permission profile')}` : undefined,
    findRequirementValue(item, 'Workspace policy') ? `cwd ${findRequirementValue(item, 'Workspace policy')}` : undefined,
    item.state.error ? `error ${item.state.error}` : undefined,
  ].filter((value): value is string => Boolean(value));
}

type CapabilityAssessmentPortabilityValue = NonNullable<CapabilityCenterItem['assessment']>['portability'];
type CapabilityAssessmentPriorityValue = NonNullable<CapabilityCenterItem['assessment']>['priority'];

function getAssessmentPriorityClass(priority: CapabilityAssessmentPriorityValue): string {
  switch (priority) {
    case 'P0':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    case 'P1':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
    case 'P2':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    default:
      return 'border-zinc-600 bg-zinc-900 text-zinc-300';
  }
}

function formatAssessmentPortability(
  portability: CapabilityAssessmentPortabilityValue,
  labels: CapabilityCenterText['assessmentPortability'] = DEFAULT_CAPABILITY_CENTER_TEXT.assessmentPortability,
): string {
  switch (portability) {
    case 'native':
      return labels.native;
    case 'portable_model':
      return labels.portable_model;
    case 'reference_only':
      return labels.reference_only;
    case 'reject':
      return labels.reject;
    default:
      return portability;
  }
}

function formatAssessment(
  item: CapabilityCenterItem,
  text: CapabilityCenterText = DEFAULT_CAPABILITY_CENTER_TEXT,
): string[] {
  const assessment = item.assessment;
  if (!assessment) return [];
  return [
    `${assessment.priority} · ${formatAssessmentPortability(assessment.portability, text.assessmentPortability)}`,
    assessment.recommendedUse,
    ...assessment.evidenceRefs.map((ref) => `evidence · ${ref}`),
  ];
}

function formatSource(item: CapabilityCenterItem): string[] {
  return [
    `${item.source.kind} · ${item.source.label}`,
    item.source.path,
    item.source.url,
    item.source.version ? `version ${item.source.version}` : undefined,
    item.source.author ? `author ${item.source.author}` : undefined,
    item.source.reviewedAt ? `reviewed ${item.source.reviewedAt}` : undefined,
    item.source.expiresAt ? `expires ${item.source.expiresAt}` : undefined,
    item.source.keyId ? `key ${item.source.keyId}` : undefined,
    item.source.contentHash ? `hash ${item.source.contentHash}` : undefined,
    item.source.registryFileHash ? `registry hash ${item.source.registryFileHash}` : undefined,
  ].filter((value): value is string => Boolean(value));
}

function formatAudit(item: CapabilityCenterItem): string[] {
  return [
    ...(item.audit.installedFiles || []),
    ...(item.audit.configFiles || []),
    ...(item.audit.notes || []),
  ];
}

function formatInstallPlan(item: CapabilityCenterItem): string[] {
  const plan = item.installPlan;
  if (!plan) return [];
  return [
    `${plan.mode} · ${plan.title}`,
    plan.summary,
    ...plan.writes.map((write) => `write ${write.kind} · ${write.action} · ${write.target}${write.note ? ` · ${write.note}` : ''}`),
    ...plan.steps.map((step) => `step · ${step}`),
    ...plan.safety.map((entry) => `safety · ${entry}`),
    ...plan.rollback.map((entry) => `rollback · ${entry}`),
  ];
}

function formatDiagnostic(diagnostic: CapabilityCenterDiagnostic): string {
  const target = diagnostic.itemId || diagnostic.path || 'registry';
  const hashes = [
    diagnostic.expectedHash ? `expected ${diagnostic.expectedHash}` : undefined,
    diagnostic.actualHash ? `actual ${diagnostic.actualHash}` : undefined,
  ].filter(Boolean).join(' · ');
  const blocking = diagnostic.blocking ? ' · blocking' : '';
  return `${diagnostic.severity}${blocking} · ${diagnostic.code} · ${target}: ${diagnostic.message}${hashes ? ` · ${hashes}` : ''}`;
}

interface CapabilityCenterSettingsProps {
  onNavigateSettings?: (tab: SettingsTab) => void;
}

export const CapabilityCenterSettings: React.FC<CapabilityCenterSettingsProps> = ({ onNavigateSettings }) => {
  const { t } = useI18n();
  const capabilityText = t.settings.capabilities;
  const {
    inventory,
    items,
    loading,
    error,
    actionResult,
    actionKey,
    reload,
    clearActionResult,
    setEnabled,
    installDraft,
    removeDraft,
  } = useCapabilityInventory();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | CapabilityKind>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');

  const filteredItems = useMemo(() => items.filter((item) => {
    if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
    if (!matchesSource(item, sourceFilter)) return false;
    if (!matchesHealth(item, healthFilter)) return false;
    return matchQuery(item, query);
  }), [items, kindFilter, sourceFilter, healthFilter, query]);
  const availableTemplateCount = useMemo(
    () => items.filter((item) => item.state.install === 'available').length,
    [items],
  );
  const registryDiagnostics = useMemo(
    () => (inventory?.diagnostics || []).filter((diagnostic) => diagnostic.source === 'registry'),
    [inventory],
  );

  useEffect(() => {
    if (!actionResult) return undefined;
    const timeout = window.setTimeout(() => {
      clearActionResult();
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [actionResult, clearActionResult]);

  return (
    <SettingsPage
      title={capabilityText.title}
      description={capabilityText.description}
    >
      <SettingsSection
        title={capabilityText.overviewTitle}
        actions={(
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void reload()}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {capabilityText.refresh}
          </Button>
        )}
      >
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <SummaryTile label={capabilityText.summary.all} value={inventory?.summary.total ?? 0} />
          <SummaryTile label={capabilityText.summary.installed} value={inventory?.summary.installed ?? 0} />
          <SummaryTile label={capabilityText.summary.enabled} value={inventory?.summary.enabled ?? 0} />
          <SummaryTile label={capabilityText.summary.templates} value={availableTemplateCount} />
          <SummaryTile label={capabilityText.summary.blocked} value={inventory?.summary.blocked ?? 0} />
          <SummaryTile label={capabilityText.summary.highRisk} value={inventory?.summary.highRisk ?? 0} />
        </div>
      </SettingsSection>

      {registryDiagnostics.length > 0 ? (
        <SettingsDetails
          title={capabilityText.registryWarnings.title}
          description={`${registryDiagnostics.length}${capabilityText.registryWarnings.descriptionSuffix}`}
        >
          <div className="space-y-2 text-xs leading-relaxed text-amber-200">
            {registryDiagnostics.slice(0, 6).map((diagnostic) => (
              <div
                key={`${diagnostic.code}:${diagnostic.path || ''}:${diagnostic.itemId || ''}:${diagnostic.message}`}
                className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{formatDiagnostic(diagnostic)}</span>
              </div>
            ))}
            {registryDiagnostics.length > 6 ? (
              <div className="text-zinc-500">
                {capabilityText.registryWarnings.hiddenPrefix}{registryDiagnostics.length - 6}{capabilityText.registryWarnings.hiddenSuffix}
              </div>
            ) : null}
          </div>
        </SettingsDetails>
      ) : null}

      <SettingsSection title={capabilityText.capabilitySectionTitle}>
        <div className="space-y-3">
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={capabilityText.searchPlaceholder}
                inputSize="sm"
                className="pl-8 pr-8"
              />
              {query ? (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {KIND_FILTERS.map((filter) => (
                <FilterButton
                  key={filter}
                  active={kindFilter === filter}
                  onClick={() => setKindFilter(filter)}
                >
                  {filter === 'all' ? capabilityText.summary.all : capabilityText.kindLabels[filter]}
                </FilterButton>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Filter className="mt-1 h-3.5 w-3.5 text-zinc-500" />
              {SOURCE_FILTERS.map((filter) => (
                <FilterButton
                  key={filter}
                  active={sourceFilter === filter}
                  onClick={() => setSourceFilter(filter)}
                >
                  {getSourceFilterLabel(filter, capabilityText.sourceLabels, capabilityText.sourceFilters.all)}
                </FilterButton>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Filter className="mt-1 h-3.5 w-3.5 text-zinc-500" />
              {HEALTH_FILTERS.map((filter) => (
                <FilterButton
                  key={filter}
                  active={healthFilter === filter}
                  onClick={() => setHealthFilter(filter)}
                >
                  {getHealthFilterLabel(filter, capabilityText.healthFilters)}
                </FilterButton>
              ))}
            </div>
          </div>

          {actionResult ? (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{actionResult.text}</span>
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="rounded-lg bg-zinc-800 p-6 text-center text-sm text-zinc-400">
              {capabilityText.noMatches}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredItems.map((item) => (
                <CapabilityCard
                  key={item.id}
                  item={item}
                  text={capabilityText}
                  actionLoading={actionKey === item.id}
                  onToggle={(target, enabled) => void setEnabled(target, enabled)}
                  onInstallDraft={(target, inputs) => void installDraft(target, inputs)}
                  onRemoveDraft={(target) => void removeDraft(target)}
                  onNavigateSettings={onNavigateSettings}
                />
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsDetails
        title={capabilityText.securityBoundary.title}
        description={capabilityText.securityBoundary.description}
      >
        <div className="space-y-2 text-xs leading-relaxed text-zinc-400">
          <div className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>{capabilityText.securityBoundary.skillBoundary}</span>
          </div>
          <div className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>{capabilityText.securityBoundary.templateBoundary}</span>
          </div>
        </div>
      </SettingsDetails>
    </SettingsPage>
  );
};

interface SummaryTileProps {
  label: string;
  value: number;
}

const SummaryTile: React.FC<SummaryTileProps> = ({ label, value }) => (
  <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-2 text-center">
    <div className="text-base font-semibold text-zinc-100">{value}</div>
    <div className="text-[11px] text-zinc-500">{label}</div>
  </div>
);

interface FilterButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const FilterButton: React.FC<FilterButtonProps> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`rounded border px-2 py-1 text-xs transition-colors ${
      active
        ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
        : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
    }`}
  >
    {children}
  </button>
);
