import type {
  BlockedCapabilityReason,
  TurnWorkbenchSnapshot,
} from '@shared/contract/turnTimeline';
import type { WorkbenchCapabilities } from '../hooks/useWorkbenchCapabilities';
import {
  buildBlockedCapabilityReasonFromRegistryItem,
  buildSelectedWorkbenchCapabilityRegistryItems,
} from './workbenchCapabilityRegistry';

export function buildBlockedCapabilityReasons(
  snapshot: TurnWorkbenchSnapshot | undefined,
  capabilities: WorkbenchCapabilities,
): BlockedCapabilityReason[] {
  return buildSelectedWorkbenchCapabilityRegistryItems(snapshot, capabilities)
    .map(buildBlockedCapabilityReasonFromRegistryItem)
    .filter((reason): reason is BlockedCapabilityReason => Boolean(reason));
}
