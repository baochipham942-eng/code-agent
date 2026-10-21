// ============================================================================
// Plugin tool origin registry
// ============================================================================

export interface PluginToolOrigin {
  pluginId: string;
  pluginName: string;
}

interface ToolOriginEntry extends PluginToolOrigin {
  builtin: boolean;
}

const MAX_PLUGIN_DISPLAY_NAME_LENGTH = 40;
const toolOrigins = new Map<string, ToolOriginEntry>();

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

export function register(
  toolName: string,
  pluginId: string,
  displayName?: string,
  builtin = false,
): void {
  toolOrigins.set(toolName, {
    pluginId,
    pluginName: resolvePluginDisplayName(pluginId, undefined, displayName),
    builtin,
  });
}

export function unregister(toolName: string): void {
  toolOrigins.delete(toolName);
}

export function getPluginIdForTool(toolName: string): string | undefined {
  return toolOrigins.get(toolName)?.pluginId;
}

export function getPluginOriginForTool(toolName: string): PluginToolOrigin | undefined {
  // builtin 能力（browser / 图像 / 音视频等）与第三方插件共用同一注册通道，
  // 但「来自插件」标签只该在第三方插件行动时出现：builtin 工具的用户可见
  // origin 隐藏，审计 / 决策trace 仍走 getPluginIdForTool（pluginId 保留）。
  const entry = toolOrigins.get(toolName);
  if (!entry || entry.builtin) return undefined;
  return { pluginId: entry.pluginId, pluginName: entry.pluginName };
}
