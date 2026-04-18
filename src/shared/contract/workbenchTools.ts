import type { ToolCall } from './tool';

export type WorkbenchReferenceKind = 'skill' | 'connector' | 'mcp';

export interface WorkbenchToolReferenceMatch {
  kind: WorkbenchReferenceKind;
  id: string;
  action?: string;
}

export const CONNECTOR_TOOL_NAMES: Record<string, string[]> = {
  mail: ['mail', 'mail_send', 'mail_draft'],
  calendar: ['calendar', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event'],
  reminders: ['reminders', 'reminders_create', 'reminders_update', 'reminders_delete'],
};

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
