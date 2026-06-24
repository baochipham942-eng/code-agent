export type TauriEventHandler<T> = (event: { payload: T }) => void;
export type TauriUnlisten = () => void;

export interface PickNativeDirectoryOptions {
  title?: string;
}

export async function listenTauriEvent<T>(
  event: string,
  handler: TauriEventHandler<T>,
): Promise<TauriUnlisten> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, handler);
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
