import type { ToolCall } from '@shared/contract/tool';
import type {
  BlockedCapabilityReason,
  TurnCapabilityInvocationItem,
  TurnCapabilityScope,
  TurnCapabilityScopeItem,
  TurnWorkbenchSnapshot,
} from '@shared/contract/turnTimeline';
import {
  buildWorkbenchHistory,
  type WorkbenchCapabilities,
} from '../hooks/useWorkbenchCapabilities';
import {
  buildBlockedCapabilityReasonFromRegistryItem,
  buildSelectedWorkbenchCapabilityRegistryItems,
  type WorkbenchCapabilityRegistryItem,
} from './workbenchCapabilityRegistry';

function toScopeItem(
  capability: WorkbenchCapabilityRegistryItem,
): TurnCapabilityScopeItem {
  return {
    kind: capability.kind,
    id: capability.id,
    label: capability.label,
  };
}

export function buildWorkbenchCapabilityScope(args: {
  snapshot?: TurnWorkbenchSnapshot;
  capabilities: WorkbenchCapabilities;
  toolCalls?: ToolCall[];
  timestamp: number;
}): TurnCapabilityScope | undefined {
  const selectedItems = buildSelectedWorkbenchCapabilityRegistryItems(
    args.snapshot,
    args.capabilities,
  );
  const selected = selectedItems.map(toScopeItem);
  const allowed = selectedItems
    .filter((capability) => capability.available)
    .map(toScopeItem);
  const blocked = selectedItems
    .map(buildBlockedCapabilityReasonFromRegistryItem)
    .filter((reason): reason is BlockedCapabilityReason => Boolean(reason));
  const invokedHistory = args.toolCalls?.length
    ? buildWorkbenchHistory({
      messages: [
        {
          timestamp: args.timestamp,
          toolCalls: args.toolCalls,
        },
      ],
      skills: args.capabilities.skills,
      connectors: args.capabilities.connectors,
      mcpServers: args.capabilities.mcpServers,
    })
    : [];
  const invoked: TurnCapabilityInvocationItem[] = invokedHistory.map((item) => ({
    kind: item.kind,
    id: item.id,
    label: item.label,
    count: item.count,
    topActions: item.topActions,
  }));

  if (selected.length === 0 && allowed.length === 0 && blocked.length === 0 && invoked.length === 0) {
    return undefined;
  }

  return {
    selected,
    allowed,
    blocked,
    invoked,
  };
}
