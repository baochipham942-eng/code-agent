export type TauriEventHandler<T> = (event: { payload: T }) => void;
export type TauriUnlisten = () => void;

export interface PickNativeDirectoryOptions {
  title?: string;
}

export interface PickNativeFileOptions {
  title?: string;
  extensions?: string[];
}

export interface SaveNativeFileOptions {
  title?: string;
  defaultPath?: string;
  extensions?: string[];
}

export async function listenTauriEvent<T>(
  event: string,
  handler: TauriEventHandler<T>,
): Promise<TauriUnlisten> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, handler);
}

export async function isNativeWindowFullscreen(): Promise<boolean> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().isFullscreen();
}

export async function openNativePath(path: string): Promise<void> {
  const { openPath } = await import('@tauri-apps/plugin-opener');
  await openPath(path);
}

export async function openNativeUrl(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

export async function revealNativePath(path: string): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

export async function pickNativeDirectory(
  options: PickNativeDirectoryOptions = {},
): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({
    directory: true,
    multiple: false,
    ...(options.title ? { title: options.title } : {}),
  });
  return typeof result === 'string' ? result : null;
}

export async function pickNativeFile(
  options: PickNativeFileOptions = {},
): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({
    directory: false,
    multiple: false,
    ...(options.title ? { title: options.title } : {}),
    ...(options.extensions?.length
      ? { filters: [{ name: 'Plugin', extensions: options.extensions }] }
      : {}),
  });
  return typeof result === 'string' ? result : null;
}

export async function saveNativeFile(
  options: SaveNativeFileOptions = {},
): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const result = await save({
    ...(options.title ? { title: options.title } : {}),
    ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    ...(options.extensions?.length
      ? { filters: [{ name: 'Skill export', extensions: options.extensions }] }
      : {}),
  });
  return typeof result === 'string' ? result : null;
}
