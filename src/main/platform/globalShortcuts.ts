// ============================================================================
// Platform: Global Shortcuts - 替代 Electron globalShortcut
// ============================================================================
//
// Web/CLI 模式下为 no-op。
// Tauri 桌面模式应通过 tauri-plugin-global-shortcut 实现。
//

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ShortcutCallback = (...args: any[]) => void;

const registeredShortcuts = new Map<string, ShortcutCallback>();

export const globalShortcut = {
  register(accelerator: string, callback: ShortcutCallback): boolean {
    registeredShortcuts.set(accelerator, callback);
    // TODO: Integrate with tauri-plugin-global-shortcut for desktop mode
    return false;
  },
  registerAll(_accelerators: string[], _callback: ShortcutCallback): void {},
  unregister(accelerator: string): void {
    registeredShortcuts.delete(accelerator);
  },
  unregisterAll(): void {
    registeredShortcuts.clear();
  },
  isRegistered(accelerator: string): boolean {
    return registeredShortcuts.has(accelerator);
  },
};
