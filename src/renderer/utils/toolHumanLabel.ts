import type { Translations } from '../i18n';
import { findConnectorIdForToolName } from '@shared/contract/workbenchTools';
import { getToolDisplayName } from '../components/features/chat/MessageBubble/ToolCallDisplay/utils';

type HumanToolLabels = Translations['receiptPresentation']['humanToolLabels'];

const CONNECTOR_LABEL_KEYS: Record<string, keyof HumanToolLabels['connectors']> = {
  mail: 'mail',
  calendar: 'calendar',
  reminders: 'reminders',
  tmeet: 'tmeet',
};

const TOOL_LABEL_KEYS: Record<string, keyof HumanToolLabels['tools']> = {
  webfetch: 'webFetch',
  websearch: 'webSearch',
  read: 'readFile',
  readfile: 'readFile',
  memorysearch: 'memorySearch',
};

function normalizedLabelKey(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[-_\s]/g, '');
}

function bareToolName(ownerLabel: string | undefined): string {
  return ownerLabel?.split('·').pop()?.trim() || '';
}

export function getHumanToolLabel(args: {
  connector?: string;
  toolName?: string;
  labels: HumanToolLabels;
}): string {
  const toolName = bareToolName(args.toolName);
  const connectorId = args.connector || findConnectorIdForToolName(toolName);
  const connectorKey = CONNECTOR_LABEL_KEYS[normalizedLabelKey(connectorId)];
  if (connectorKey) return args.labels.connectors[connectorKey];

  const toolKey = TOOL_LABEL_KEYS[normalizedLabelKey(toolName)];
  if (toolKey) return args.labels.tools[toolKey];

  return getToolDisplayName(toolName || args.labels.unknownTool);
}
