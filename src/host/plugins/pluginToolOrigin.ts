// ============================================================================
// Plugin tool origin registry
// ============================================================================

const toolOrigins = new Map<string, string>();

export function register(toolName: string, pluginId: string): void {
  toolOrigins.set(toolName, pluginId);
}

export function unregister(toolName: string): void {
  toolOrigins.delete(toolName);
}

export function getPluginIdForTool(toolName: string): string | undefined {
  return toolOrigins.get(toolName);
}
