import { findConnectorIdForToolName } from '@shared/contract/workbenchTools';
import type { Translations } from '../i18n';
import { getHumanToolLabel } from './toolHumanLabel';

type HumanToolLabels = Translations['receiptPresentation']['humanToolLabels'];
type RoleCapabilityLabels = Translations['receiptPresentation']['roleCapabilityLabels'];
type RoleCapabilityKey = Exclude<
  keyof RoleCapabilityLabels,
  'otherAbility' | 'otherAbilities' | 'separator'
>;

const TOOL_CAPABILITY_KEYS: Readonly<Record<string, RoleCapabilityKey>> = {
  read: 'readAndFindFiles',
  readfile: 'readAndFindFiles',
  glob: 'readAndFindFiles',
  grep: 'readAndFindFiles',
  listdirectory: 'readAndFindFiles',
  write: 'writeAndEditFiles',
  writefile: 'writeAndEditFiles',
  edit: 'writeAndEditFiles',
  editfile: 'writeAndEditFiles',
  multiedit: 'writeAndEditFiles',
  bash: 'runCommands',
  websearch: 'searchTheWeb',
  webfetch: 'openWebPages',
  memoryread: 'rememberAndRecall',
  memorywrite: 'rememberAndRecall',
  history: 'rememberAndRecall',
};

function normalizedToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s]/g, '');
}

export function getRoleToolCapabilities(args: {
  toolNames: readonly string[];
  capabilityLabels: RoleCapabilityLabels;
  humanToolLabels: HumanToolLabels;
}): string[] {
  const capabilities: string[] = [];
  const seenCapabilities = new Set<string>();
  const unknownToolNames = new Set<string>();

  const addCapability = (label: string): void => {
    if (!label || seenCapabilities.has(label)) return;
    seenCapabilities.add(label);
    capabilities.push(label);
  };

  for (const rawToolName of args.toolNames) {
    const toolName = rawToolName.trim();
    if (!toolName) continue;

    const connectorId = findConnectorIdForToolName(toolName);
    if (connectorId) {
      const connectorLabel = getHumanToolLabel({
        connector: connectorId,
        toolName,
        labels: args.humanToolLabels,
      });
      addCapability(connectorLabel);
      continue;
    }

    const normalizedName = normalizedToolName(toolName);
    const capabilityKey = TOOL_CAPABILITY_KEYS[normalizedName];
    if (capabilityKey) {
      addCapability(args.capabilityLabels[capabilityKey]);
      continue;
    }

    unknownToolNames.add(normalizedName);
  }

  if (unknownToolNames.size > 0) {
    const fallback = unknownToolNames.size === 1
      ? args.capabilityLabels.otherAbility
      : args.capabilityLabels.otherAbilities;
    capabilities.push(
      fallback.replace('{count}', String(unknownToolNames.size)),
    );
  }

  return capabilities;
}
