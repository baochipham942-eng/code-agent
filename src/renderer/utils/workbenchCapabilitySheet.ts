import type { WorkbenchHistoryItem, WorkbenchReference } from '../hooks/useWorkbenchCapabilities';
import {
  buildWorkbenchConnectorRegistryItem,
  buildWorkbenchMcpRegistryItem,
  buildWorkbenchSkillRegistryItem,
  type WorkbenchCapabilityRegistryItem,
} from './workbenchCapabilityRegistry';

export interface WorkbenchCapabilityTarget {
  kind: 'skill' | 'connector' | 'mcp';
  id: string;
}

export function getWorkbenchCapabilityTargetKey(target: WorkbenchCapabilityTarget): string {
  return `${target.kind}:${target.id}`;
}

export function findWorkbenchCapabilityHistoryItem(
  history: WorkbenchHistoryItem[],
  target: WorkbenchCapabilityTarget,
): WorkbenchHistoryItem | null {
  return history.find((item) => item.kind === target.kind && item.id === target.id) || null;
}

export function buildWorkbenchCapabilityRegistryItemFromReference(
  reference: WorkbenchReference,
): WorkbenchCapabilityRegistryItem {
  switch (reference.kind) {
    case 'skill':
      return buildWorkbenchSkillRegistryItem({
        kind: 'skill',
        id: reference.id,
        label: reference.label,
        selected: reference.selected,
        mounted: reference.mounted,
        installState: reference.installState,
        description: reference.description,
        source: reference.source,
        libraryId: reference.libraryId,
      });
    case 'connector':
      return buildWorkbenchConnectorRegistryItem({
        kind: 'connector',
        id: reference.id,
        label: reference.label,
        selected: reference.selected,
        connected: reference.connected,
        detail: reference.detail,
        capabilities: reference.capabilities,
      });
    case 'mcp':
      return buildWorkbenchMcpRegistryItem({
        kind: 'mcp',
        id: reference.id,
        label: reference.label,
        selected: reference.selected,
        status: reference.status,
        enabled: reference.enabled,
        transport: reference.transport,
        toolCount: reference.toolCount,
        resourceCount: reference.resourceCount,
        error: reference.error,
      });
    default:
      throw new Error('Unsupported workbench capability reference');
  }
}

export function resolveWorkbenchCapabilityFromSources(args: {
  target: WorkbenchCapabilityTarget | null;
  primaryItems?: WorkbenchCapabilityRegistryItem[];
  secondaryItems?: WorkbenchCapabilityRegistryItem[];
  references?: WorkbenchReference[];
}): WorkbenchCapabilityRegistryItem | null {
  const { target, primaryItems = [], secondaryItems = [], references = [] } = args;
  if (!target) {
    return null;
  }

  const fromPrimary = primaryItems.find((item) => item.kind === target.kind && item.id === target.id);
  if (fromPrimary) {
    return fromPrimary;
  }

  const fromSecondary = secondaryItems.find((item) => item.kind === target.kind && item.id === target.id);
  if (fromSecondary) {
    return fromSecondary;
  }

  const fromReference = references.find((reference) => reference.kind === target.kind && reference.id === target.id);
  if (fromReference) {
    return buildWorkbenchCapabilityRegistryItemFromReference(fromReference);
  }

  return null;
}
