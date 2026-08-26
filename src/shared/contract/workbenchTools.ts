import type { ToolCall } from './tool';
import { CLI_CONNECTOR_DESCRIPTORS } from '../constants/cliConnectorDescriptors';
import type { CliConnectorToolAction } from './cliConnectorDescriptor';

export type WorkbenchReferenceKind = 'skill' | 'connector' | 'mcp';

export interface WorkbenchToolReferenceMatch {
  kind: WorkbenchReferenceKind;
  id: string;
  action?: string;
}

const NATIVE_CONNECTOR_TOOL_NAMES: Record<string, string[]> = {
  mail: ['mail', 'mail_send', 'mail_draft'],
  calendar: ['calendar', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event'],
  reminders: ['reminders', 'reminders_create', 'reminders_update', 'reminders_delete'],
};

const NATIVE_CONNECTOR_WRITE_ACTIONS: Readonly<Record<string, CliConnectorToolAction>> = {
  mail_send: { zh: '发送邮件', en: 'send an email' },
  mail_draft: { zh: '保存邮件草稿', en: 'save an email draft' },
  calendar_create_event: { zh: '创建日程', en: 'create an event' },
  calendar_update_event: { zh: '修改日程', en: 'update an event' },
  calendar_delete_event: { zh: '删除日程', en: 'delete an event' },
  reminders_create: { zh: '创建提醒事项', en: 'create a reminder' },
  reminders_update: { zh: '修改提醒事项', en: 'update a reminder' },
  reminders_delete: { zh: '删除提醒事项', en: 'delete a reminder' },
};

export const CONNECTOR_TOOL_NAMES = CLI_CONNECTOR_DESCRIPTORS.reduce<Record<string, string[]>>(
  (toolNames, descriptor) => {
    toolNames[descriptor.id] = descriptor.toolNames;
    return toolNames;
  },
  { ...NATIVE_CONNECTOR_TOOL_NAMES },
);

export const ALL_CONNECTOR_TOOL_NAMES = new Set(
  Object.values(CONNECTOR_TOOL_NAMES).flat(),
);

export function isConnectorToolName(toolName: string): boolean {
  return ALL_CONNECTOR_TOOL_NAMES.has(toolName);
}

export function findConnectorIdForToolName(toolName: string): string | undefined {
  return Object.entries(CONNECTOR_TOOL_NAMES)
    .find(([, names]) => names.includes(toolName))?.[0];
}

export interface ConnectorToolMetadata {
  connectorId: string;
  connectorName: string;
  connectorNameEn: string;
  action?: CliConnectorToolAction;
}

export function findConnectorToolMetadata(toolName: string): ConnectorToolMetadata | undefined {
  const descriptor = CLI_CONNECTOR_DESCRIPTORS.find((item) => item.toolNames.includes(toolName));
  if (descriptor) {
    return {
      connectorId: descriptor.id,
      connectorName: descriptor.displayName,
      connectorNameEn: descriptor.displayNameEn ?? descriptor.displayName,
      action: descriptor.writeActions?.[toolName],
    };
  }

  const connectorId = findConnectorIdForToolName(toolName);
  if (!connectorId) return undefined;
  const nativeNames: Record<string, string> = {
    mail: '邮件',
    calendar: '日历',
    reminders: '提醒事项',
  };
  const nativeNamesEn: Record<string, string> = {
    mail: 'Mail',
    calendar: 'Calendar',
    reminders: 'Reminders',
  };
  return {
    connectorId,
    connectorName: nativeNames[connectorId] ?? connectorId,
    connectorNameEn: nativeNamesEn[connectorId] ?? connectorId,
    action: NATIVE_CONNECTOR_WRITE_ACTIONS[toolName],
  };
}

export function connectorExternalWriteReason(toolName: string, language: 'zh' | 'en' = 'zh'): string | undefined {
  const metadata = findConnectorToolMetadata(toolName);
  if (!metadata?.action) return undefined;
  return language === 'en'
    ? `Writing to an external system (${metadata.connectorNameEn}: ${metadata.action.en}) requires your confirmation`
    : `要在外部系统里写入（${metadata.connectorName}：${metadata.action.zh}），需要你确认`;
}

export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith('mcp__') || toolName.startsWith('mcp_');
}

export function extractMcpServerIdFromToolName(toolName: string): string | undefined {
  if (toolName.startsWith('mcp__')) {
    const match = toolName.match(/^mcp__(.+?)__/);
    return match?.[1];
  }

  if (toolName.startsWith('mcp_')) {
    const remainder = toolName.slice(4);
    const separatorIndex = remainder.indexOf('_');
    return separatorIndex > 0 ? remainder.slice(0, separatorIndex) : undefined;
  }

  return undefined;
}

export function extractSkillIdFromToolCall(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): string | undefined {
  const nameLower = toolCall.name.toLowerCase();
  if (nameLower === 'skill') {
    const args = toolCall.arguments as Record<string, unknown> | undefined;
    const rawSkillId = args?.command || args?.skill || args?.name || args?.skill_name;
    return typeof rawSkillId === 'string' && rawSkillId.trim() ? rawSkillId.trim() : undefined;
  }

  if (nameLower.startsWith('skill_')) {
    return toolCall.name.slice(6) || undefined;
  }

  return undefined;
}

export function extractWorkbenchReferenceFromToolCall(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): WorkbenchToolReferenceMatch | null {
  const skillId = extractSkillIdFromToolCall(toolCall);
  if (skillId) {
    return {
      kind: 'skill',
      id: skillId,
    };
  }

  const connectorId = findConnectorIdForToolName(toolCall.name);
  if (connectorId) {
    return {
      kind: 'connector',
      id: connectorId,
      action: toolCall.name === connectorId
        ? connectorId
        : toolCall.name.replace(`${connectorId}_`, ''),
    };
  }

  const mcpServerId = extractMcpServerIdFromToolName(toolCall.name);
  if (mcpServerId) {
    return {
      kind: 'mcp',
      id: mcpServerId,
      action: toolCall.name.startsWith('mcp__')
        ? toolCall.name.replace(`mcp__${mcpServerId}__`, '')
        : toolCall.name.replace(`mcp_${mcpServerId}_`, ''),
    };
  }

  return null;
}
