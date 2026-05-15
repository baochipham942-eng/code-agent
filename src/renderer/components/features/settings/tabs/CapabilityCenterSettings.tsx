// ============================================================================
// CapabilityCenterSettings - local capability inventory and audit surface
// ============================================================================

import React, { useMemo, useState } from 'react';
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
  ToggleLeft,
  ToggleRight,
  Wrench,
  Workflow,
  X,
} from 'lucide-react';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { Button, Input, type ButtonVariant } from '../../../primitives';
import { useCapabilityInventory } from '../../../../hooks/useCapabilityInventory';
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

const KIND_LABELS: Record<CapabilityKind, string> = {
  skill: 'Skill',
  mcp_template: 'MCP',
  tool_bundle: 'Tool',
  channel_adapter: 'Channel',
  workflow_recipe: 'Workflow',
  connector: 'Connector',
};

const RUNTIME_LABELS: Record<CapabilityRuntimeState, string> = {
  ready: 'Ready',
  connected: 'Connected',
  lazy: 'Lazy',
  disconnected: 'Disconnected',
  not_configured: 'Needs config',
  blocked: 'Blocked',
  error: 'Error',
  unknown: 'Unknown',
};

const SOURCE_LABELS: Partial<Record<CapabilitySourceKind, string>> = {
  builtin: 'Built-in',
  curated: 'Curated',
  project: 'Project',
  user: 'User',
  library: 'Library',
  runtime: 'Runtime',
  memory: 'Memory',
  cloud: 'Cloud',
  team: 'Team',
  local: 'Local',
  marketplace: 'Marketplace',
  remote: 'Remote',
  plugin: 'Plugin',
};

const KIND_FILTERS: Array<'all' | CapabilityKind> = [
  'all',
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

function getHealthFilterLabel(filter: HealthFilter): string {
  switch (filter) {
    case 'ready':
      return 'Ready';
    case 'needs_config':
      return 'Needs config';
    case 'disabled':
      return 'Disabled';
    case 'error':
      return 'Error';
    default:
      return 'All';
  }
}

function getSourceFilterLabel(filter: SourceFilter): string {
  return filter === 'all' ? 'All sources' : SOURCE_LABELS[filter] || filter;
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
    ...item.tags,
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

function getSettingsActionLabel(item: CapabilityCenterItem): string {
  return item.state.install === 'available' || item.state.runtime === 'not_configured'
    ? '去配置'
    : '去管理';
}

function getCapabilityActionPresentation(
  item: CapabilityCenterItem,
  canNavigateSettings: boolean,
): CapabilityActionPresentation {
  if (item.installPlan && item.state.install === 'available') {
    if (item.actions.canInstallDraft) {
      return {
        label: '生成草稿',
        variant: 'secondary',
        disabled: false,
        title: item.installPlan.summary,
        leftIcon: <PackageCheck className="h-3.5 w-3.5" />,
        nextEnabled: null,
        settingsTab: null,
        installDraft: true,
      };
    }
    return {
      label: '安装预览',
      variant: 'secondary',
      disabled: true,
      title: item.installPlan.summary,
      leftIcon: <PackageCheck className="h-3.5 w-3.5" />,
      nextEnabled: null,
      settingsTab: null,
      installDraft: false,
    };
  }

  if (item.state.enable === 'not_applicable') {
    const settingsTab = getCapabilitySettingsTab(item);
    return {
      label: settingsTab ? getSettingsActionLabel(item) : '只读',
      variant: 'ghost',
      disabled: !settingsTab || !canNavigateSettings,
      title: item.actions.reason,
      leftIcon: <FileCog className="h-3.5 w-3.5" />,
      nextEnabled: null,
      settingsTab,
      installDraft: false,
    };
  }

  const isEnabled = item.state.enable === 'enabled';
  const canToggle = isEnabled ? item.actions.canDisable : item.actions.canEnable;
  if (!canToggle) {
    const settingsTab = getCapabilitySettingsTab(item);
    return {
      label: settingsTab ? getSettingsActionLabel(item) : '只读',
      variant: 'ghost',
      disabled: !settingsTab || !canNavigateSettings,
      title: item.actions.reason,
      leftIcon: <FileCog className="h-3.5 w-3.5" />,
      nextEnabled: null,
      settingsTab,
      installDraft: false,
    };
  }

  return {
    label: isEnabled ? '禁用' : '启用',
    variant: isEnabled ? 'ghost' : 'secondary',
    disabled: false,
    title: undefined,
    leftIcon: isEnabled ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />,
    nextEnabled: !isEnabled,
    settingsTab: null,
    installDraft: false,
  };
}

interface CapabilityCardProps {
  item: CapabilityCenterItem;
  actionLoading: boolean;
  onToggle: (item: CapabilityCenterItem, enabled: boolean) => void;
  onInstallDraft: (item: CapabilityCenterItem) => void;
  onNavigateSettings?: (tab: SettingsTab) => void;
}

const CapabilityCard: React.FC<CapabilityCardProps> = ({ item, actionLoading, onToggle, onInstallDraft, onNavigateSettings }) => {
  const missingConfig = missingRequirements([...item.config, ...item.dependencies]);
  const action = getCapabilityActionPresentation(item, Boolean(onNavigateSettings));

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
                {KIND_LABELS[item.kind]}
              </span>
              <span className={`rounded border px-1.5 py-0.5 text-[11px] ${getRiskClass(item.risk.tier)}`}>
                {item.risk.tier}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">{item.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className={getRuntimeClass(item.state.runtime)}>
                {RUNTIME_LABELS[item.state.runtime]}
              </span>
              <span className="text-zinc-500">{item.source.label}</span>
              {item.state.statusLabel ? <span className="text-zinc-500">{item.state.statusLabel}</span> : null}
              {item.metrics?.tools !== undefined ? <span className="text-zinc-500">{item.metrics.tools} tools</span> : null}
              {item.metrics?.accounts !== undefined ? <span className="text-zinc-500">{item.metrics.accounts} account</span> : null}
            </div>
          </div>
        </div>

        <Button
          size="sm"
          variant={action.variant}
          loading={actionLoading}
          disabled={action.disabled}
          title={action.title}
          leftIcon={action.leftIcon}
          onClick={() => {
            if (action.settingsTab) {
              onNavigateSettings?.(action.settingsTab);
            } else if (action.installDraft) {
              onInstallDraft(item);
            } else if (action.nextEnabled !== null) {
              onToggle(item, action.nextEnabled);
            }
          }}
        >
          {action.label}
        </Button>
      </div>

      {(missingConfig.length > 0 || item.state.error) && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            {item.state.error ? <div className="truncate">{item.state.error}</div> : null}
            {missingConfig.length > 0 ? (
              <div className="truncate">
                缺少 {missingConfig.map((req) => req.label).join(', ')}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <details className="group mt-3 rounded-lg border border-zinc-700/60 bg-zinc-900/40">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs text-zinc-400">
          <span>权限、配置与审计</span>
          <span className="text-zinc-500 group-open:hidden">展开</span>
          <span className="hidden text-zinc-500 group-open:inline">收起</span>
        </summary>
        <div className="space-y-3 border-t border-zinc-700/60 px-3 py-3 text-xs">
          {item.installPlan ? <InfoBlock title="安装预览" values={formatInstallPlan(item)} /> : null}
          <InfoBlock title="权限" values={item.permissions.map((entry) => `${entry.label}${entry.detail ? ` · ${entry.detail}` : ''}`)} />
          <InfoBlock title="风险" values={item.risk.reasons} />
          <InfoBlock title="配置" values={item.config.map(formatRequirement)} empty="无配置项" />
          <InfoBlock title="依赖" values={item.dependencies.map(formatRequirement)} empty="无依赖项" />
          <InfoBlock title="来源" values={formatSource(item)} />
          <InfoBlock title="审计" values={formatAudit(item)} empty="暂无审计记录" />
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

const InfoBlock: React.FC<InfoBlockProps> = ({ title, values, empty = '无' }) => (
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

function formatSource(item: CapabilityCenterItem): string[] {
  return [
    `${item.source.kind} · ${item.source.label}`,
    item.source.path,
    item.source.url,
    item.source.version ? `version ${item.source.version}` : undefined,
    item.source.author ? `author ${item.source.author}` : undefined,
    item.source.reviewedAt ? `reviewed ${item.source.reviewedAt}` : undefined,
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
  return `${diagnostic.severity} · ${diagnostic.code} · ${target}: ${diagnostic.message}${hashes ? ` · ${hashes}` : ''}`;
}

interface CapabilityCenterSettingsProps {
  onNavigateSettings?: (tab: SettingsTab) => void;
}

export const CapabilityCenterSettings: React.FC<CapabilityCenterSettingsProps> = ({ onNavigateSettings }) => {
  const {
    inventory,
    items,
    loading,
    error,
    actionKey,
    reload,
    setEnabled,
    installDraft,
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

  return (
    <SettingsPage
      title="能力中心"
      description="本地 Skills、MCP、Tools、Connectors、Channels 和 workflow recipes 的库存与审计。"
    >
      <SettingsSection
        title="总览"
        actions={(
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void reload()}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
          </Button>
        )}
      >
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <SummaryTile label="全部" value={inventory?.summary.total ?? 0} />
          <SummaryTile label="已安装" value={inventory?.summary.installed ?? 0} />
          <SummaryTile label="已启用" value={inventory?.summary.enabled ?? 0} />
          <SummaryTile label="模板" value={availableTemplateCount} />
          <SummaryTile label="阻塞" value={inventory?.summary.blocked ?? 0} />
          <SummaryTile label="高风险" value={inventory?.summary.highRisk ?? 0} />
        </div>
      </SettingsSection>

      {registryDiagnostics.length > 0 ? (
        <SettingsDetails
          title="Registry warnings"
          description={`${registryDiagnostics.length} 条本地 registry 诊断。坏文件或坏项会被跳过，不会进入安装或启用链路。`}
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
              <div className="text-zinc-500">还有 {registryDiagnostics.length - 6} 条 registry 诊断未展开。</div>
            ) : null}
          </div>
        </SettingsDetails>
      ) : null}

      <SettingsSection title="能力">
        <div className="space-y-3">
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索能力、权限、配置或来源"
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
                  {filter === 'all' ? 'All' : KIND_LABELS[filter]}
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
                  {getSourceFilterLabel(filter)}
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
                  {getHealthFilterLabel(filter)}
                </FilterButton>
              ))}
            </div>
          </div>

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
              没有匹配的能力
            </div>
          ) : (
            <div className="space-y-3">
              {filteredItems.map((item) => (
                <CapabilityCard
                  key={item.id}
                  item={item}
                  actionLoading={actionKey === item.id}
                  onToggle={(target, enabled) => void setEnabled(target, enabled)}
                  onInstallDraft={(target) => void installDraft(target)}
                  onNavigateSettings={onNavigateSettings}
                />
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsDetails
        title="安全边界"
        description="安装、启用、连接和真实调用分开记录。P0 不执行远程模板安装。"
      >
        <div className="space-y-2 text-xs leading-relaxed text-zinc-400">
          <div className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>Skill 的 allowed-tools 不会给 user/project/library skill 自动扩权。</span>
          </div>
          <div className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>MCP 模板只能生成禁用草稿；Channel 和 Workflow 模板仍回到各自设置页。</span>
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
