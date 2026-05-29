import React from 'react';
import { Eye, Wrench, Brain, Cpu, Terminal, Code2, Gauge } from 'lucide-react';
import type { ModelProvider } from '@shared/contract';
import type {
  AgentEngineDescriptor,
  AgentEngineKind,
  AgentEngineSessionMetadata,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import type { RuntimeModelFeature } from '@shared/modelRuntime';
import type { EffortLevel } from '../../../shared/contract/agent';
import { getProviderLogoBadge, getProviderLogoMark } from './providerLogoCatalog';

export const QUICK_SWITCH_PROVIDERS = [
  'moonshot',
  'xiaomi',
  'longcat',
  'deepseek',
  'zhipu',
  'openai',
  'claude',
  'gemini',
  'qwen',
  'minimax',
  'openrouter',
  'perplexity',
  'grok',
  'volcengine',
  'local',
  'custom',
] as const satisfies readonly ModelProvider[];

export const ENGINE_SHORT_LABEL: Record<AgentEngineKind, string> = {
  native: 'Agent Neo',
  codex_cli: 'Codex',
  claude_code: 'Claude',
};

export const ENGINE_ICON: Record<AgentEngineKind, React.ReactNode> = {
  native: <Cpu className="w-3 h-3" />,
  codex_cli: <Terminal className="w-3 h-3" />,
  claude_code: <Terminal className="w-3 h-3" />,
};

export const ENGINE_INSTALL_LABEL: Record<AgentEngineDescriptor['installState'], string> = {
  builtin: '内置',
  installed: '已安装',
  missing: '未安装',
};

export const ENGINE_RUNTIME_LABEL: Record<AgentEngineDescriptor['runtimeState'], string> = {
  ready: 'Ready',
  not_configured: 'Needs config',
  blocked: 'Blocked',
  error: 'Error',
  unknown: 'Unknown',
};

export const ENGINE_PERMISSION_LABEL: Record<AgentEngineDescriptor['defaultPermissionProfile'], string> = {
  default: '默认权限',
  read_only: '只读默认',
  workspace_write: '工作目录可写',
};

const ENGINE_RISK_LABEL: Record<AgentEngineDescriptor['riskTier'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

export interface EffortOption {
  value: EffortLevel;
  label: string;
  shortLabel: string;
  color: string;
  tint: string;
}

const EFFORT_OPTION_CONFIG: Record<EffortLevel, EffortOption> = {
  low: {
    value: 'low',
    label: 'Low',
    shortLabel: 'Low',
    color: 'text-zinc-400',
    tint: 'bg-zinc-700',
  },
  medium: {
    value: 'medium',
    label: 'Med',
    shortLabel: 'Med',
    color: 'text-blue-400',
    tint: 'bg-blue-500/15',
  },
  high: {
    value: 'high',
    label: 'High',
    shortLabel: 'High',
    color: 'text-amber-400',
    tint: 'bg-amber-500/15',
  },
  xhigh: {
    value: 'xhigh',
    label: 'XHigh',
    shortLabel: 'XHigh',
    color: 'text-orange-300',
    tint: 'bg-orange-500/15',
  },
  max: {
    value: 'max',
    label: 'Max',
    shortLabel: 'Max',
    color: 'text-rose-300',
    tint: 'bg-rose-500/15',
  },
  ultra_code: {
    value: 'ultra_code',
    label: 'Ultra Code',
    shortLabel: 'Ultra',
    color: 'text-emerald-300',
    tint: 'bg-emerald-500/15',
  },
};

const BASE_EFFORT_OPTIONS = [
  EFFORT_OPTION_CONFIG.low,
  EFFORT_OPTION_CONFIG.medium,
  EFFORT_OPTION_CONFIG.high,
];

const EXTENDED_EFFORT_OPTIONS = [
  ...BASE_EFFORT_OPTIONS,
  EFFORT_OPTION_CONFIG.xhigh,
  EFFORT_OPTION_CONFIG.max,
];

const CODE_EFFORT_OPTIONS = [
  ...BASE_EFFORT_OPTIONS,
  EFFORT_OPTION_CONFIG.xhigh,
  EFFORT_OPTION_CONFIG.ultra_code,
];

const XIAOMI_EFFORT_OPTIONS: EffortOption[] = [
  {
    ...EFFORT_OPTION_CONFIG.low,
    label: 'Off',
    shortLabel: 'Off',
  },
  {
    ...EFFORT_OPTION_CONFIG.high,
    label: 'Thinking',
    shortLabel: 'Think',
  },
];

const SINGLE_EFFORT_OPTION: EffortOption[] = [
  {
    ...EFFORT_OPTION_CONFIG.low,
    label: 'Default',
    shortLabel: 'Default',
  },
];

const PROVIDER_LOGO_BADGE_CLASSNAME = 'bg-zinc-100 text-zinc-950 border border-zinc-300';

export const CAPABILITY_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  code: {
    icon: <Code2 className="w-2.5 h-2.5" />,
    color: 'bg-emerald-500/20 text-emerald-300',
  },
  vision: {
    icon: <Eye className="w-2.5 h-2.5" />,
    color: 'bg-purple-500/20 text-purple-300',
  },
  tool: {
    icon: <Wrench className="w-2.5 h-2.5" />,
    color: 'bg-blue-500/20 text-blue-300',
  },
  reasoning: {
    icon: <Brain className="w-2.5 h-2.5" />,
    color: 'bg-amber-500/20 text-amber-300',
  },
  fast: {
    icon: <Gauge className="w-2.5 h-2.5" />,
    color: 'bg-sky-500/20 text-sky-300',
  },
  longContext: {
    icon: <span className="text-[9px] font-semibold">LC</span>,
    color: 'bg-teal-500/20 text-teal-300',
  },
};

export const HEALTH_DOT_COLOR: Record<string, string> = {
  healthy: 'bg-green-400',
  degraded: 'bg-yellow-400',
  unavailable: 'bg-red-400',
  recovering: 'bg-blue-400',
};

export function formatEngineCwdPolicy(descriptor: AgentEngineDescriptor): string {
  return descriptor.cwdPolicy === 'workspace_only' ? '当前工作目录' : descriptor.cwdPolicy;
}

export function getEngineUnavailableReason(
  descriptor: AgentEngineDescriptor,
  needsWorkspace: boolean,
): string | null {
  if (needsWorkspace) return '需要先选择工作目录';
  if (!descriptor.executable) return descriptor.lastError || 'CLI 不可执行';
  if (descriptor.installState === 'missing') return descriptor.lastError || '未安装';
  if (descriptor.runtimeState === 'error' || descriptor.runtimeState === 'blocked') {
    return descriptor.lastError || ENGINE_RUNTIME_LABEL[descriptor.runtimeState];
  }
  return null;
}

export function formatEngineTooltip(descriptor: AgentEngineDescriptor, needsWorkspace: boolean): string {
  const unavailableReason = getEngineUnavailableReason(descriptor, needsWorkspace);
  return [
    descriptor.label,
    descriptor.kind === 'native' ? 'Native · 内置 runtime' : '外部 CLI',
    `${ENGINE_INSTALL_LABEL[descriptor.installState]} / ${ENGINE_RUNTIME_LABEL[descriptor.runtimeState]}`,
    unavailableReason,
    descriptor.version,
    ENGINE_PERMISSION_LABEL[descriptor.defaultPermissionProfile],
    formatEngineCwdPolicy(descriptor),
    ENGINE_RISK_LABEL[descriptor.riskTier],
    descriptor.command,
    descriptor.lastError,
  ].filter(Boolean).join(' · ');
}

export function isExternalEngineKind(kind: AgentEngineKind): kind is ExternalAgentEngineKind {
  return kind === 'codex_cli' || kind === 'claude_code';
}

export function buildModelSwitcherEngineSelection(
  descriptor: AgentEngineDescriptor,
  workingDirectory?: string | null,
  model?: string | null,
): Partial<AgentEngineSessionMetadata> {
  const selection: Partial<AgentEngineSessionMetadata> = {
    kind: descriptor.kind,
    permissionProfile: descriptor.defaultPermissionProfile,
    origin: 'manual',
  };
  if (descriptor.kind !== 'native' && workingDirectory) {
    selection.cwd = workingDirectory;
  }
  if (descriptor.kind !== 'native' && model) {
    selection.model = model;
  }
  return selection;
}

export function ProviderLogo({ provider, label }: { provider: ModelProvider; label: string }) {
  const mark = getProviderLogoMark(provider);
  if (mark) {
    const paths = mark.paths ?? (mark.path ? [mark.path] : []);
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-2.5 w-2.5 fill-current"
          role="img"
        >
          <title>{mark.title}</title>
          {paths.map((path) => (
            <path key={path} d={path} />
          ))}
        </svg>
      </span>
    );
  }

  const badge = getProviderLogoBadge(provider);
  const badgeLabel = badge?.label ?? (label.trim()[0] || provider[0] || '?').toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[3px] px-[2px] text-[7px] font-bold leading-none ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
    >
      {badgeLabel}
    </span>
  );
}

export function getProviderEffortOptions(
  provider: ModelProvider,
  model: string,
  features: readonly RuntimeModelFeature[] = [],
): EffortOption[] {
  if (provider === 'xiaomi') return XIAOMI_EFFORT_OPTIONS;
  if (provider === 'claude') return EXTENDED_EFFORT_OPTIONS;
  if (provider === 'openai' && /codex|code/i.test(model)) return CODE_EFFORT_OPTIONS;
  if (provider === 'openai') return BASE_EFFORT_OPTIONS;
  if (provider === 'grok' || provider === 'perplexity') {
    return features.includes('reasoning') ? BASE_EFFORT_OPTIONS : SINGLE_EFFORT_OPTION;
  }
  return features.includes('reasoning') || /reason|thinking|think|r1|o\d/i.test(model)
    ? BASE_EFFORT_OPTIONS
    : SINGLE_EFFORT_OPTION;
}

export function getEngineEffortOptions(kind: AgentEngineKind): EffortOption[] {
  if (kind === 'codex_cli') return CODE_EFFORT_OPTIONS;
  if (kind === 'claude_code') return EXTENDED_EFFORT_OPTIONS;
  return BASE_EFFORT_OPTIONS;
}

export function getSelectedEffortOption(
  effortLevel: EffortLevel,
  options: readonly EffortOption[],
): EffortOption {
  return options.find((option) => option.value === effortLevel)
    ?? options.find((option) => option.value === 'high')
    ?? options[options.length - 1]
    ?? EFFORT_OPTION_CONFIG.high;
}
