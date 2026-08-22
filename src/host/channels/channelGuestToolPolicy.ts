import type { ToolDefinition } from '../../shared/contract';

const GUEST_FORBIDDEN_TOOL_NAME = /(?:bash|browser|computer|mcp|cron|schedul|delegate|spawn|agent|workflow|terminal|shell)/i;

export function isGuestChannelToolAllowed(tool: ToolDefinition): boolean {
  return tool.permissionLevel === 'read'
    && tool.source !== 'mcp'
    && !GUEST_FORBIDDEN_TOOL_NAME.test(tool.name);
}

/** Selects the strict allowlist consumed by the existing run-policy tool gate. */
export function selectGuestChannelAllowedToolNames(tools: readonly ToolDefinition[]): string[] {
  return tools.filter(isGuestChannelToolAllowed).map((tool) => tool.name);
}
