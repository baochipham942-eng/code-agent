// ============================================================================
// Plugin tool origin registry
// ============================================================================

export interface PluginToolOrigin {
  pluginId: string;
  pluginName: string;
}

const MAX_PLUGIN_DISPLAY_NAME_LENGTH = 40;
const toolOrigins = new Map<string, PluginToolOrigin>();

export function resolvePluginDisplayName(
  pluginId: string,
  name?: string,
  displayName?: string,
): string {
  const candidate = [displayName, name, pluginId]
    .find((value) => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? pluginId.trim();
  return candidate.length > MAX_PLUGIN_DISPLAY_NAME_LENGTH
    ? `${candidate.slice(0, MAX_PLUGIN_DISPLAY_NAME_LENGTH - 1)}…`
    : candidate;
}

export function register(toolName: string, pluginId: string, displayName?: string): void {
  toolOrigins.set(toolName, {
    pluginId,
    pluginName: resolvePluginDisplayName(pluginId, undefined, displayName),
  });
}

export function unregister(toolName: string): void {
  toolOrigins.delete(toolName);
}

export function getPluginIdForTool(toolName: string): string | undefined {
  return toolOrigins.get(toolName)?.pluginId;
}

export function getPluginOriginForTool(toolName: string): PluginToolOrigin | undefined {
  return toolOrigins.get(toolName);
}
