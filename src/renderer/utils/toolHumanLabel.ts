import type { Translations } from '../i18n';
import { getToolDisplayName } from '../components/features/chat/MessageBubble/ToolCallDisplay/utils';

type HumanToolLabels = Translations['receiptPresentation']['humanToolLabels'];

const CONNECTOR_LABEL_KEYS: Record<string, keyof HumanToolLabels['connectors']> = {
  mail: 'mail',
  calendar: 'calendar',
  reminders: 'reminders',
};

// 没有显式 connector 时，从工具名前缀反推它属于哪个外部系统。
// 「上下文」区的连接器行只有工具名（ToolCapabilityView.label，如 mail_send），
// 拿不到 artifact metadata 里的 connector；靠这张表复用同一套人话名，
// 不为那一区另开第二份映射。
const CONNECTOR_FROM_TOOL_PREFIX: Array<[string, keyof HumanToolLabels['connectors']]> = [
  ['mail', 'mail'],
  ['calendar', 'calendar'],
  ['reminders', 'reminders'],
];

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
  const connectorKey = CONNECTOR_LABEL_KEYS[normalizedLabelKey(args.connector)];
  if (connectorKey) return args.labels.connectors[connectorKey];

  const toolName = bareToolName(args.toolName);
  const toolKey = TOOL_LABEL_KEYS[normalizedLabelKey(toolName)];
  if (toolKey) return args.labels.tools[toolKey];

  const normalizedTool = normalizedLabelKey(toolName);
  const inferred = CONNECTOR_FROM_TOOL_PREFIX.find(([prefix]) => normalizedTool.startsWith(prefix));
  if (inferred) return args.labels.connectors[inferred[1]];

  return getToolDisplayName(toolName || args.labels.unknownTool);
}
