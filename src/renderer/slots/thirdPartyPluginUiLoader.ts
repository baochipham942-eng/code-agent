import type { InstalledCapabilityPackage } from '@shared/contract/capabilityPackage';
import { IPC_CHANNELS } from '@shared/ipc';
import { UI_SLOT_CONTRACTS, type UiSlotName } from '@shared/contract/uiSlots';
import ipcService from '../services/ipcService';
import { acquireRemoteRendererBundle } from '../internalFeatures/remoteRendererBundle';
import { RENDERER_INTERNAL_SDK_VERSION } from '../internalFeatures/internalSdkVersion';
import {
  activatePluginUiWithPolicy,
  unloadPluginUiWithPolicy,
} from './pluginUiActivationPolicy';
import { slots } from './pluginUiSdk';
import {
  clearPluginUiRuntimeAdmission,
  setPluginUiRuntimeAdmission,
} from './pluginUiRuntimeAdmission';

interface PluginUiRemote {
  activate: () => unknown | Promise<unknown>;
}

const knownPluginIds = new Set<string>();
const activeHashByPlugin = new Map<string, string>();
const unsignedLocations = new Set<UiSlotName>(['workspace.page', 'settings.section']);
let refreshQueue: Promise<void> = Promise.resolve();

function globalName(pluginId: string): string {
  return `__neoPluginUi_${pluginId.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function fileName(relativePath: string): string {
  return relativePath.split(/[\\/]/u).at(-1) ?? relativePath;
}

function requestedLocations(plugin: InstalledCapabilityPackage): UiSlotName[] {
  const requested = plugin.pluginUi?.requestedUiSlots ?? [];
  if (!requested.every((name): name is UiSlotName => (
    Object.prototype.hasOwnProperty.call(UI_SLOT_CONTRACTS, name)
  ))) {
    throw new Error('这个插件申请了当前版本不支持的显示位置，请重新安装');
  }
  return requested;
}

function assertRendererAdmission(plugin: InstalledCapabilityPackage): UiSlotName[] {
  const detail = plugin.pluginUi;
  if (!detail) throw new Error('这个插件缺少界面文件，请重新安装');
  if (detail.sdkVersion.renderer !== RENDERER_INTERNAL_SDK_VERSION) {
    throw new Error('这个插件的界面版本与当前应用不匹配，请重新安装');
  }
  const requested = requestedLocations(plugin);
  if (detail.sourceTrust.level === 'unsigned' && requested.some((name) => !unsignedLocations.has(name))) {
    throw new Error('这个插件的来源未经验证，不能出现在产品主界面中');
  }
  return requested;
}

function assertRegisteredLocations(pluginId: string, requested: readonly UiSlotName[]): void {
  const allowed = new Set(requested);
  const used = (Object.keys(UI_SLOT_CONTRACTS) as UiSlotName[]).filter((name) => (
    slots.get(name)?.occupants.some((occupant) => occupant.pluginId === pluginId)
  ));
  if (used.some((name) => !allowed.has(name))) {
    throw new Error('这个插件尝试出现在没有获准的显示位置，已停止装载');
  }
}

async function reportLoadState(pluginId: string, error?: string): Promise<void> {
  const result = await ipcService.invoke(
    IPC_CHANNELS.CAPABILITY_PACKAGE_UI_LOAD_STATE,
    pluginId,
    error,
  );
  if (result && !result.success) {
    console.warn(`[ThirdPartyPluginUiLoader] ${pluginId} load state was not recorded`, result.error);
  }
}

async function loadPlugin(plugin: InstalledCapabilityPackage): Promise<boolean> {
  const detail = plugin.pluginUi;
  const requested = assertRendererAdmission(plugin);
  if (!detail) return false;
  const encodedId = encodeURIComponent(plugin.id);
  const encodedHash = encodeURIComponent(detail.loadedHash);
  const entryUrl = `/plugin-ui/${encodedId}/${encodeURIComponent(fileName(detail.rendererEntry))}?v=${encodedHash}`;
  const cssUrl = `/plugin-ui/${encodedId}/${encodeURIComponent(fileName(detail.rendererStyles))}?v=${encodedHash}`;

  setPluginUiRuntimeAdmission(plugin.id, requested);
  try {
    const loaded = await activatePluginUiWithPolicy('third-party', plugin.id, async () => {
      slots.effect(() => {
        if (activeHashByPlugin.get(plugin.id) === detail.loadedHash) {
          activeHashByPlugin.delete(plugin.id);
        }
        clearPluginUiRuntimeAdmission(plugin.id);
      });
      const bundle = acquireRemoteRendererBundle<PluginUiRemote>({
        cacheKey: `plugin-ui:${plugin.id}:${detail.loadedHash}`,
        cssUrl,
        dataAttribute: 'data-plugin-ui',
        entryUrl,
        globalName: globalName(plugin.id),
        ownerId: plugin.id,
        readModule: (value) => {
          const remote = value as Partial<PluginUiRemote> | undefined;
          if (typeof remote?.activate !== 'function') {
            throw new Error('这个插件没有提供可装载的界面入口');
          }
          return remote as PluginUiRemote;
        },
      });
      slots.effect(bundle.dispose);
      const remote = await bundle.promise;
      const result = await remote.activate();
      if (result !== undefined) {
        throw new Error('这个插件没有按约定接入应用，已停止装载');
      }
      assertRegisteredLocations(plugin.id, requested);
    });
    if (!loaded) clearPluginUiRuntimeAdmission(plugin.id);
    if (loaded) activeHashByPlugin.set(plugin.id, detail.loadedHash);
    return loaded;
  } catch (error) {
    clearPluginUiRuntimeAdmission(plugin.id);
    throw error;
  }
}

function packageList(result: unknown): InstalledCapabilityPackage[] {
  if (Array.isArray(result)) return result as InstalledCapabilityPackage[];
  const envelope = result as {
    success?: boolean;
    data?: InstalledCapabilityPackage[];
    error?: string;
  } | null | undefined;
  if (!envelope?.success || !Array.isArray(envelope.data)) {
    throw new Error(envelope?.error || '插件列表读取失败');
  }
  return envelope.data;
}

async function refreshInstalledPluginUi(
  installedPackages?: InstalledCapabilityPackage[],
): Promise<void> {
  const packages = installedPackages ?? packageList(
    await ipcService.invoke(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST),
  );
  const plugins = packages.filter((plugin) => plugin.surface === 'ui');
  const installedIds = new Set(plugins.map((plugin) => plugin.id));

  for (const pluginId of [...knownPluginIds]) {
    if (installedIds.has(pluginId)) continue;
    knownPluginIds.delete(pluginId);
    await unloadPluginUiWithPolicy(pluginId);
    activeHashByPlugin.delete(pluginId);
    clearPluginUiRuntimeAdmission(pluginId);
  }

  for (const plugin of plugins) {
    knownPluginIds.add(plugin.id);
    if (plugin.pluginUi && activeHashByPlugin.get(plugin.id) === plugin.pluginUi.loadedHash) continue;
    try {
      const loaded = await loadPlugin(plugin);
      if (loaded) await reportLoadState(plugin.id);
    } catch (error) {
      await unloadPluginUiWithPolicy(plugin.id);
      const message = error instanceof Error ? error.message : String(error);
      await reportLoadState(plugin.id, message);
    }
  }
}

export function refreshThirdPartyPluginUi(
  installedPackages?: InstalledCapabilityPackage[],
): Promise<void> {
  const refresh = refreshQueue.then(() => refreshInstalledPluginUi(installedPackages));
  refreshQueue = refresh.catch(() => undefined);
  return refresh;
}
