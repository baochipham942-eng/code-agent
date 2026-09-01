const allowedLocationsByPlugin = new Map<string, ReadonlySet<string>>();

export function setPluginUiRuntimeAdmission(
  pluginId: string,
  allowedLocations: readonly string[],
): void {
  allowedLocationsByPlugin.set(pluginId, new Set(allowedLocations));
}

export function clearPluginUiRuntimeAdmission(pluginId: string): void {
  allowedLocationsByPlugin.delete(pluginId);
}

export function assertPluginUiRuntimeAdmission(pluginId: string, location: string): void {
  const allowed = allowedLocationsByPlugin.get(pluginId);
  if (allowed && !allowed.has(location)) {
    throw new Error('这个插件尝试出现在没有获准的显示位置，已停止装载');
  }
}
