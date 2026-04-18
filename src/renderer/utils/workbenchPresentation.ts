import type {
  WorkbenchHistoryAction,
  WorkbenchReference,
  WorkbenchSkillCapability,
} from '../hooks/useWorkbenchCapabilities';
import type { WorkbenchCapabilityRegistryItem } from './workbenchCapabilityRegistry';

type WorkbenchRuntimeStatus = 'connected' | 'disconnected' | 'connecting' | 'error' | 'lazy';
type Locale = 'en' | 'zh';

const STATUS_LABELS: Record<WorkbenchRuntimeStatus, { en: string; zh: string; colorClass: string }> = {
  connected: {
    en: 'connected',
    zh: '已连接',
    colorClass: 'text-green-400',
  },
  disconnected: {
    en: 'disconnected',
    zh: '未连接',
    colorClass: 'text-zinc-400',
  },
  connecting: {
    en: 'connecting',
    zh: '连接中',
    colorClass: 'text-yellow-400',
  },
  error: {
    en: 'error',
    zh: '错误',
    colorClass: 'text-red-400',
  },
  lazy: {
    en: 'lazy',
    zh: '懒加载',
    colorClass: 'text-sky-400',
  },
};

function getLocaleLabel(locale: Locale, value: { en: string; zh: string }): string {
  return locale === 'zh' ? value.zh : value.en;
}

export function getWorkbenchStatusPresentation(
  status: WorkbenchRuntimeStatus,
  options?: { locale?: Locale },
): { label: string; colorClass: string } {
  const locale = options?.locale || 'en';
  const presentation = STATUS_LABELS[status];
  return {
    label: getLocaleLabel(locale, presentation),
    colorClass: presentation.colorClass,
  };
}

export function getWorkbenchConnectorStatusPresentation(
  connected: boolean,
  options?: { locale?: Locale },
): { label: string; colorClass: string } {
  return getWorkbenchStatusPresentation(connected ? 'connected' : 'disconnected', options);
}

export function formatWorkbenchHistoryActionSummary(
  actions: WorkbenchHistoryAction[],
  options?: { maxActions?: number },
): string | null {
  if (actions.length === 0) {
    return null;
  }

  const maxActions = options?.maxActions ?? 2;
  return actions
    .slice(0, maxActions)
    .map((action) => action.count > 1 ? `${action.label} ${action.count}x` : action.label)
    .join(' · ');
}

export function formatWorkbenchSkillSecondaryText(
  skill: Pick<WorkbenchSkillCapability, 'description' | 'source'>,
  options?: { locale?: Locale },
): string | undefined {
  if (skill.description) {
    return skill.description;
  }

  if (!skill.source) {
    return undefined;
  }

  const locale = options?.locale || 'zh';
  return locale === 'zh' ? `来源: ${skill.source}` : `source: ${skill.source}`;
}

export function getWorkbenchSkillCapabilityTitle(
  skill: Pick<WorkbenchSkillCapability, 'label' | 'description' | 'source' | 'installState'>,
  options?: { locale?: Locale },
): string | undefined {
  const locale = options?.locale || 'zh';
  const parts = [skill.label];
  const secondary = formatWorkbenchSkillSecondaryText(skill, { locale });
  if (secondary) {
    parts.push(secondary);
  }
  if (skill.installState !== 'mounted') {
    parts.push(
      locale === 'zh'
        ? `状态: ${skill.installState === 'available' ? '已安装未挂载' : '当前不可用'}`
        : `status: ${skill.installState === 'available' ? 'installed but not mounted' : 'currently unavailable'}`,
    );
  }
  return parts.join('\n');
}

export function getWorkbenchCapabilityStatusPresentation(
  capability: WorkbenchCapabilityRegistryItem,
  options?: { locale?: Locale },
): { label: string; colorClass: string } {
  const locale = options?.locale || 'en';

  if (capability.kind === 'skill') {
    if (capability.lifecycle.mountState === 'mounted') {
      return {
        label: locale === 'zh' ? '已挂载' : 'mounted',
        colorClass: 'text-green-400',
      };
    }

    if (capability.lifecycle.installState === 'installed') {
      return {
        label: locale === 'zh' ? '已安装未挂载' : 'installed, not mounted',
        colorClass: 'text-amber-400',
      };
    }

    return {
      label: locale === 'zh' ? '当前不可用' : 'unavailable',
      colorClass: 'text-red-400',
    };
  }

  if (capability.kind === 'connector') {
    return getWorkbenchConnectorStatusPresentation(capability.connected, options);
  }

  return getWorkbenchStatusPresentation(capability.status, options);
}

export function getWorkbenchCapabilityTitle(
  capability: WorkbenchCapabilityRegistryItem,
  options?: { locale?: Locale },
): string | undefined {
  const locale = options?.locale || 'zh';
  const parts = [capability.label];
  const status = getWorkbenchCapabilityStatusPresentation(capability, { locale });

  if (capability.selected) {
    parts.push(locale === 'zh' ? '已加入本次消息范围' : 'selected for this turn');
  }

  if (capability.kind === 'skill') {
    const secondary = formatWorkbenchSkillSecondaryText(capability, { locale });
    if (secondary) {
      parts.push(secondary);
    }
  } else if (capability.kind === 'connector' && capability.detail) {
    parts.push(capability.detail);
  } else if (capability.kind === 'mcp') {
    parts.push(`transport: ${capability.transport}`);
    if (!capability.enabled) {
      parts.push(locale === 'zh' ? '已禁用' : 'disabled');
    }
    if (capability.error) {
      parts.push(capability.error);
    }
  }

  parts.push(`${locale === 'zh' ? '状态' : 'status'}: ${status.label}`);

  if (capability.blockedReason) {
    parts.push(capability.blockedReason.detail);
    parts.push(capability.blockedReason.hint);
  }

  return parts.join('\n');
}

export function getWorkbenchReferenceTitle(
  reference: WorkbenchReference,
  options?: { locale?: Locale },
): string | undefined {
  const locale = options?.locale || 'zh';
  const parts = [
    reference.kind === 'skill' ? reference.description : reference.kind === 'connector' ? reference.detail : undefined,
    reference.kind === 'skill' && reference.source
      ? (locale === 'zh' ? `来源: ${reference.source}` : `source: ${reference.source}`)
      : undefined,
    reference.kind === 'mcp' ? `transport: ${reference.transport}` : undefined,
    reference.kind === 'skill' && !reference.mounted && reference.installState === 'available'
      ? (locale === 'zh' ? '当前已安装但未挂载' : 'installed but not mounted')
      : undefined,
    reference.kind === 'skill' && !reference.mounted && reference.installState === 'missing'
      ? (locale === 'zh' ? '本轮调用过，但当前共享能力模型里没有对应安装信息' : 'invoked in this turn but missing from the shared capability model')
      : undefined,
    reference.kind === 'connector' && !reference.connected
      ? (locale === 'zh' ? '本轮调用过，但当前未连接' : 'invoked in this turn but currently disconnected')
      : undefined,
    reference.kind === 'mcp' && reference.status !== 'connected'
      ? `${locale === 'zh' ? '当前状态' : 'status'}: ${getWorkbenchStatusPresentation(reference.status, { locale }).label}`
      : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : undefined;
}

export function getWorkbenchReferenceBadge(
  reference: WorkbenchReference,
  options?: { locale?: Locale },
): string | null {
  const locale = options?.locale || 'zh';
  if (reference.kind === 'skill' && !reference.mounted) {
    if (reference.installState === 'available') {
      return locale === 'zh' ? '可挂载' : 'mountable';
    }
    return locale === 'zh' ? '调用' : 'invoked';
  }
  if (reference.kind === 'connector') {
    return 'Connector';
  }
  if (reference.kind === 'mcp') {
    return 'MCP';
  }
  return null;
}
