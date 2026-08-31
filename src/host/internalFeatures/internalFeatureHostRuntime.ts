import { createRequire } from 'node:module';
import path from 'node:path';
import { ipcHost } from '../platform';
import { verifyPluginApprovalReceipt } from '../plugins/pluginApprovalReceipt';
import { getPluginRegistry } from '../plugins/pluginRegistry';
import type { LoadedPlugin } from '../plugins/types';
import { recordCapabilityPackageLifecycle } from '../services/capabilities/capabilityPackageLifecycle';
import { createLogger } from '../services/infra/logger';
import { assertInternalFeatureHostCompatibility } from './internalFeatureContract';
import { INTERNAL_HOST_SDK } from './internalHostSdk';

const pluginRequire = typeof require === 'function' ? require : createRequire(import.meta.url);
const INTERNAL_FEATURE_ALLOWLIST = ['evaluation-center'] as const;

type RuntimeRegistry = {
  getPlugins(): LoadedPlugin[];
};

type RuntimeLogger = Pick<ReturnType<typeof createLogger>, 'error' | 'info' | 'warn'>;

interface InternalFeatureHostRuntimeDependencies {
  registry: RuntimeRegistry;
  ipcMain?: typeof ipcHost;
  sdk?: typeof INTERNAL_HOST_SDK;
  lifecycle?: typeof recordCapabilityPackageLifecycle;
  logger?: RuntimeLogger;
}

interface LoadedHostFeature {
  deactivate: () => Promise<void> | void;
  entryPath: string;
  hash: string;
}

interface HostEntryModule {
  activate?: (context: {
    ipcMain: typeof ipcHost;
    sdk: typeof INTERNAL_HOST_SDK;
  }) => Promise<unknown> | unknown;
}

declare global {
  // L2 的 host bundle stub 在模块求值阶段从这个全局读取共享模块。
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __NEO_INTERNAL_HOST_SDK__: typeof INTERNAL_HOST_SDK | undefined;
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  return candidatePath.startsWith(`${resolvedRoot}${path.sep}`);
}

function normalizeHostModule(value: unknown): HostEntryModule {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  if (record.default && typeof record.default === 'object') {
    return record.default as HostEntryModule;
  }
  return record as HostEntryModule;
}

export class InternalFeatureHostRuntime {
  private readonly registry: RuntimeRegistry;
  private readonly ipcMain: typeof ipcHost;
  private readonly sdk: typeof INTERNAL_HOST_SDK;
  private readonly lifecycle: typeof recordCapabilityPackageLifecycle;
  private readonly logger: RuntimeLogger;
  private readonly loaded = new Map<string, LoadedHostFeature>();

  constructor(dependencies: InternalFeatureHostRuntimeDependencies) {
    this.registry = dependencies.registry;
    this.ipcMain = dependencies.ipcMain ?? ipcHost;
    this.sdk = dependencies.sdk ?? INTERNAL_HOST_SDK;
    this.lifecycle = dependencies.lifecycle ?? recordCapabilityPackageLifecycle;
    this.logger = dependencies.logger ?? createLogger('InternalFeatureHostRuntime');
    globalThis.__NEO_INTERNAL_HOST_SDK__ = this.sdk;
  }

  async load(plugin: LoadedPlugin): Promise<void> {
    const pluginId = plugin.manifest.id;
    if (plugin.manifest.surfaces?.[0] !== 'internal-feature') {
      this.logger.warn(`Skipped non-internal plugin in host runtime: ${pluginId}`);
      return;
    }
    if (!INTERNAL_FEATURE_ALLOWLIST.includes(pluginId as (typeof INTERNAL_FEATURE_ALLOWLIST)[number])) {
      plugin.state = 'inactive';
      delete plugin.error;
      this.logger.warn(`Skipped internal plugin outside the first-party allowlist: ${pluginId}`);
      return;
    }

    let resolvedEntry: string | undefined;
    try {
      if (this.loaded.has(pluginId)) await this.unload(pluginId);
      assertInternalFeatureHostCompatibility(plugin.manifest);
      const receipt = await verifyPluginApprovalReceipt(
        plugin.rootPath,
        pluginId,
        plugin.manifest.permissions ?? [],
      );
      const feature = plugin.manifest.internalFeature;
      if (!feature) throw new Error('插件清单缺少 internalFeature 契约');

      const entryPath = path.resolve(plugin.rootPath, feature.hostEntry);
      if (!isInside(plugin.rootPath, entryPath)) {
        throw new Error('插件 host 入口超出插件目录');
      }

      resolvedEntry = pluginRequire.resolve(entryPath);
      delete pluginRequire.cache[resolvedEntry];
      const hostModule = normalizeHostModule(pluginRequire(resolvedEntry) as unknown);
      if (typeof hostModule.activate !== 'function') {
        throw new Error('插件 host 入口必须导出 activate(ctx)');
      }
      const handle = await hostModule.activate({ ipcMain: this.ipcMain, sdk: this.sdk });
      if (!handle || typeof handle !== 'object' || typeof (handle as { deactivate?: unknown }).deactivate !== 'function') {
        throw new Error('插件 host activate(ctx) 必须返回 deactivate()');
      }

      const deactivate = (handle as { deactivate: () => Promise<void> | void }).deactivate.bind(handle);
      this.loaded.set(pluginId, { deactivate, entryPath: resolvedEntry, hash: receipt.packageHash });
      plugin.state = 'active';
      delete plugin.error;
      this.logger.info(`Internal plugin host loaded: ${pluginId}`);
    } catch (error) {
      if (resolvedEntry) {
        delete pluginRequire.cache[resolvedEntry];
      }
      const message = error instanceof Error ? error.message : String(error);
      plugin.state = 'error';
      plugin.error = message;
      this.lifecycle(pluginId, 'failed', message);
      this.logger.error(`Internal plugin host failed: ${pluginId}`, error);
      throw error;
    }
  }

  async unload(pluginId: string): Promise<void> {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) return;
    try {
      await loaded.deactivate();
    } catch (error) {
      this.logger.error(`Internal plugin host deactivate failed; continuing unload: ${pluginId}`, error);
    } finally {
      this.loaded.delete(pluginId);
      delete pluginRequire.cache[loaded.entryPath];
    }
  }

  async loadInstalled(): Promise<void> {
    for (const plugin of this.registry.getPlugins()) {
      if (plugin.manifest.surfaces?.[0] !== 'internal-feature') continue;
      try {
        await this.load(plugin);
      } catch {
        // load() 已将原始错误写入插件状态与生命周期；启动继续服务其他插件。
      }
    }
  }

  isLoaded(pluginId: string): boolean {
    return this.loaded.has(pluginId);
  }

  loadedHash(pluginId: string): string | undefined {
    return this.loaded.get(pluginId)?.hash;
  }
}

let runtime: InternalFeatureHostRuntime | null = null;

export function getInternalFeatureHostRuntime(): InternalFeatureHostRuntime {
  runtime ??= new InternalFeatureHostRuntime({ registry: getPluginRegistry() });
  return runtime;
}
