import type { CapabilityPackagePermission } from '@shared/contract/capabilityPackage';

export interface PluginPermissionText {
  labels: Record<CapabilityPackagePermission, string>;
  descriptions: Record<CapabilityPackagePermission, string>;
  optionalSuffix: string;
}

export interface PluginPermissionEntry {
  permission: CapabilityPackagePermission;
  optional?: boolean;
}

export function formatPluginPermissionLabel(
  entry: PluginPermissionEntry,
  text: PluginPermissionText,
): string {
  return `${text.labels[entry.permission]}${entry.optional ? text.optionalSuffix : ''}`;
}

export function formatPluginPermissionDescription(
  entry: PluginPermissionEntry,
  text: PluginPermissionText,
): string {
  return `${formatPluginPermissionLabel(entry, text)}：${text.descriptions[entry.permission]}`;
}
