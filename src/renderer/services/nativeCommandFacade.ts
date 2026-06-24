import type { KeybindingActionId } from '@shared/keybindings';

export interface AppshotSlot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GlobalHotkeyBinding {
  actionId: KeybindingActionId;
  accelerator: string;
}

export interface GlobalHotkeyRegistrationResult {
  actionId: KeybindingActionId;
  accelerator: string;
  registered: boolean;
  error?: string | null;
}

export interface NativeCommandActionMap {
  triggerAppshot: {
    payload: undefined;
    result: boolean;
  };
  readAppshotImageDataUrl: {
    payload: { path: string };
    result: string;
  };
  reportAppshotComposerSlot: {
    payload: { slot: AppshotSlot };
    result: unknown;
  };
  setAppshotsEnabled: {
    payload: { enabled: boolean };
    result: unknown;
  };
  showPip: {
    payload: undefined;
    result: unknown;
  };
  framePip: {
    payload: { dataUrl: string };
    result: unknown;
  };
  hidePip: {
    payload: undefined;
    result: unknown;
  };
  setGlobalHotkeys: {
    payload: { bindings: GlobalHotkeyBinding[] };
    result: GlobalHotkeyRegistrationResult[];
  };
}

export type NativeCommandAction = keyof NativeCommandActionMap;
type NativeCommandPayload<K extends NativeCommandAction> = NativeCommandActionMap[K]['payload'];
type NativeCommandResult<K extends NativeCommandAction> = NativeCommandActionMap[K]['result'];

const NATIVE_COMMANDS: {
  [K in NativeCommandAction]: string;
} = {
  triggerAppshot: 'appshots_trigger',
  readAppshotImageDataUrl: 'appshots_read_image_data_url',
  reportAppshotComposerSlot: 'appshots_report_composer_slot',
  setAppshotsEnabled: 'appshots_set_enabled',
  showPip: 'pip_show',
  framePip: 'pip_frame',
  hidePip: 'pip_hide',
  setGlobalHotkeys: 'keybindings_set_global_hotkeys',
};

export function isNativeCommandRuntimeAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

export async function invokeNativeCommandAction<K extends NativeCommandAction>(
  action: K,
  payload?: NativeCommandPayload<K>,
): Promise<NativeCommandResult<K>> {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) {
    throw new Error('Tauri runtime not available');
  }
  return internals.invoke<NativeCommandResult<K>>(NATIVE_COMMANDS[action], payload as Record<string, unknown> | undefined);
}
