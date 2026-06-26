import type { ToolDefinition } from '../../shared/contract';
import type { WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';
import {
  CONNECTOR_TOOL_NAMES,
  extractMcpServerIdFromToolName,
  isConnectorToolName,
} from '../../shared/contract/workbenchTools';

function normalizeIds(ids?: string[]): string[] {
  return Array.from(new Set((ids || []).map((id) => id.trim()).filter(Boolean)));
}

export function normalizeWorkbenchToolScope(
  scope?: WorkbenchToolScope,
): WorkbenchToolScope | undefined {
  if (!scope) {
    return undefined;
  }

  const allowedSkillIds = normalizeIds(scope.allowedSkillIds);
  const allowedConnectorIds = normalizeIds(scope.allowedConnectorIds);
  const allowedMcpServerIds = normalizeIds(scope.allowedMcpServerIds);

  if (allowedSkillIds.length === 0 && allowedConnectorIds.length === 0 && allowedMcpServerIds.length === 0) {
    return undefined;
  }

  return {
    ...(allowedSkillIds.length > 0 ? { allowedSkillIds } : {}),
    ...(allowedConnectorIds.length > 0 ? { allowedConnectorIds } : {}),
    ...(allowedMcpServerIds.length > 0 ? { allowedMcpServerIds } : {}),
  };
}

function matchesScopedMcpTool(toolName: string, allowedServerIds: string[]): boolean {
  const serverId = extractMcpServerIdFromToolName(toolName);
  if (!serverId) {
    return true;
  }

  return allowedServerIds.includes(serverId);
}

function matchesScopedConnectorTool(toolName: string, allowedConnectorIds: string[]): boolean {
  if (!isConnectorToolName(toolName)) {
    return true;
  }

  const allowedToolNames = new Set(
    allowedConnectorIds.flatMap((connectorId) => CONNECTOR_TOOL_NAMES[connectorId] || []),
  );
  return allowedToolNames.has(toolName);
}

export function isToolNameAllowedByWorkbenchScope(
  toolName: string,
  scope?: WorkbenchToolScope,
): boolean {
  const normalizedScope = normalizeWorkbenchToolScope(scope);
  if (!normalizedScope) {
    return true;
  }

  if (normalizedScope.allowedMcpServerIds?.length
    && !matchesScopedMcpTool(toolName, normalizedScope.allowedMcpServerIds)) {
    return false;
  }

  if (normalizedScope.allowedConnectorIds?.length
    && !matchesScopedConnectorTool(toolName, normalizedScope.allowedConnectorIds)) {
    return false;
  }

  return true;
}

export function isSkillCommandAllowedByWorkbenchScope(
  skillName: string,
  scope?: WorkbenchToolScope,
): boolean {
  const normalizedScope = normalizeWorkbenchToolScope(scope);
  if (!normalizedScope?.allowedSkillIds?.length) {
    return true;
  }

  return normalizedScope.allowedSkillIds.includes(skillName);
}

export function filterToolDefinitionsByWorkbenchScope(
  tools: ToolDefinition[],
  scope?: WorkbenchToolScope,
): ToolDefinition[] {
  const normalizedScope = normalizeWorkbenchToolScope(scope);
  if (!normalizedScope) {
    return tools;
  }

  return tools.filter((tool) => isToolNameAllowedByWorkbenchScope(tool.name, normalizedScope));
}
