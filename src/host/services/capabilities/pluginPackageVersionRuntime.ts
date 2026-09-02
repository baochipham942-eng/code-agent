import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  CapabilityPackageInstallResult,
} from '../../../shared/contract/capabilityPackage';
import { writePluginApprovalReceipt } from '../../plugins/pluginApprovalReceipt';
import type { PluginPackageSourceTrust } from '../../plugins/pluginPackageTrust';
import { verifyInstalledPluginTrust } from '../../plugins/pluginPackageTrust';
import { readPluginManifest } from '../../plugins/pluginLoader';
import {
  activationMode,
  listPluginVersionStates,
  migrateLegacyPluginDirectory,
  pluginPackageRoot,
  readPluginVersionState,
  storeImmutablePluginPackage,
  writePluginVersionState,
  type PluginVersionState,
} from '../../plugins/pluginPackageVersionStore';
import type { PluginManifest } from '../../plugins/types';
import type { PluginRegistry } from '../../plugins/pluginRegistry';
import type { InternalFeatureHostRuntime } from '../../internalFeatures/internalFeatureHostRuntime';

type RegistryPort = Pick<PluginRegistry,
  'getPlugin' | 'pauseWatching' | 'resumeWatching'
  | 'installPluginFromDirectory' | 'removePluginFromRegistry'>;

type InternalFeatureRuntimePort = Pick<InternalFeatureHostRuntime, 'load' | 'unload'>;

export interface StoredPluginCandidate {
  manifest: PluginManifest;
  packageId: string;
  packageRoot: string;
  packageHash: string;
  sourceTrust: PluginPackageSourceTrust;
  approvalRequired: boolean;
}

interface PluginPackageVersionRuntimeDependencies {
  pluginsDir: () => string;
  registry: RegistryPort;
  internalFeatureRuntime: InternalFeatureRuntimePort;
  now: () => number;
  lifecycle: (id: string, action: 'loaded' | 'unloaded' | 'rolled_back' | 'failed', detail?: string) => void;
}

function packageSurface(manifest: PluginManifest): CapabilityPackageInstallResult['surface'] {
  const surface = manifest.surfaces?.[0];
  return surface === 'internal-feature' || surface === 'ui' ? surface : 'tools';
}

function currentPackagePath(pluginRoot: string, state: PluginVersionState): string | undefined {
  return state.currentPackageId ? pluginPackageRoot(pluginRoot, state.currentPackageId) : undefined;
}

export class PluginPackageVersionRuntime {
  constructor(private readonly dependencies: PluginPackageVersionRuntimeDependencies) {}

  async storeCandidate(input: {
    manifest: PluginManifest;
    sourceRoot: string;
    packageHash: string;
    sourceTrust: PluginPackageSourceTrust;
  }): Promise<StoredPluginCandidate> {
    const pluginRoot = path.join(this.dependencies.pluginsDir(), input.manifest.id);
    let state = await readPluginVersionState(pluginRoot);
    const loaded = this.dependencies.registry.getPlugin(input.manifest.id);
    if (!state && loaded && !loaded.rootPath.startsWith('builtin:')) {
      const installedTrust = await verifyInstalledPluginTrust(loaded.rootPath, loaded.manifest);
      state = await migrateLegacyPluginDirectory(pluginRoot, loaded.manifest, {
        packageHash: installedTrust.packageHash,
        sourceTrust: installedTrust.sourceTrust,
        now: this.dependencies.now(),
      });
      const migratedPath = currentPackagePath(pluginRoot, state);
      if (migratedPath) loaded.rootPath = migratedPath;
    }

    const approval = state?.approveFutureVersions ? 'approved' : 'pending';
    const watcherWasActive = this.dependencies.registry.pauseWatching();
    try {
      const stored = await storeImmutablePluginPackage(pluginRoot, input.sourceRoot, {
        manifest: input.manifest,
        packageHash: input.packageHash,
        sourceTrust: input.sourceTrust,
        approval,
        now: this.dependencies.now(),
      });
      state = stored.state;
      state.packages[stored.packageId].approval = approval;
      state.nextPackageId = stored.packageId;
      await writePluginVersionState(pluginRoot, state);
      return {
        ...input,
        packageId: stored.packageId,
        packageRoot: stored.packageRoot,
        approvalRequired: approval !== 'approved',
      };
    } finally {
      if (watcherWasActive) this.dependencies.registry.resumeWatching();
    }
  }

  async approveAndActivate(
    candidate: StoredPluginCandidate,
    approveFutureVersions: boolean,
  ): Promise<CapabilityPackageInstallResult> {
    const pluginRoot = path.join(this.dependencies.pluginsDir(), candidate.manifest.id);
    const state = await this.requireState(pluginRoot);
    const stored = state.packages[candidate.packageId];
    if (!stored) throw new Error('找不到待启动的插件版本');
    stored.approval = 'approved';
    if (approveFutureVersions) state.approveFutureVersions = true;
    await writePluginApprovalReceipt(candidate.packageRoot, {
      pluginId: candidate.manifest.id,
      packageHash: candidate.packageHash,
      permissions: candidate.manifest.permissions ?? [],
      sandboxValidatedAt: this.dependencies.now(),
      approvedAt: this.dependencies.now(),
    });
    await writePluginVersionState(pluginRoot, state);
    return this.activate(candidate.manifest.id, candidate.packageId);
  }

  async reject(candidate: StoredPluginCandidate): Promise<void> {
    const pluginRoot = path.join(this.dependencies.pluginsDir(), candidate.manifest.id);
    const state = await this.requireState(pluginRoot);
    const stored = state.packages[candidate.packageId];
    if (stored) stored.approval = 'denied';
    if (state.nextPackageId === candidate.packageId) delete state.nextPackageId;
    await writePluginVersionState(pluginRoot, state);
  }

  async activate(pluginId: string, packageId: string): Promise<CapabilityPackageInstallResult> {
    const pluginRoot = path.join(this.dependencies.pluginsDir(), pluginId);
    const state = await this.requireState(pluginRoot);
    const stored = state.packages[packageId];
    if (!stored) throw new Error('找不到这个插件版本');
    if (stored.approval !== 'approved') throw new Error('这个插件版本尚未获得授权');
    const packageRoot = pluginPackageRoot(pluginRoot, packageId);
    const manifest = await readPluginManifest(packageRoot);
    if (!manifest) throw new Error('这个插件版本缺少有效清单');
    const mode = activationMode(state.currentPackageId, packageId);
    const pluginRunId = randomUUID();
    const startedAt = this.dependencies.now();
    state.nextPackageId = packageId;
    delete state.runningPackageId;
    state.lastRun = { pluginRunId, packageId, mode, status: 'activating', startedAt };
    await writePluginVersionState(pluginRoot, state);

    const previous = this.dependencies.registry.getPlugin(pluginId);
    const isInternalFeature = manifest.surfaces?.[0] === 'internal-feature';
    const watcherWasActive = this.dependencies.registry.pauseWatching();
    let registryInstalled = false;
    try {
      if (previous?.manifest.surfaces?.[0] === 'internal-feature') {
        await this.dependencies.internalFeatureRuntime.unload(pluginId);
      }
      if (previous) await this.dependencies.registry.removePluginFromRegistry(pluginId);
      const installed = await this.dependencies.registry.installPluginFromDirectory(packageRoot);
      if (!installed.success) throw new Error(installed.error ?? '插件启动失败');
      registryInstalled = true;
      if (isInternalFeature) {
        const plugin = this.dependencies.registry.getPlugin(pluginId);
        if (!plugin) throw new Error('插件已写入磁盘，但运行时没有返回实例');
        await this.dependencies.internalFeatureRuntime.load(plugin);
      }

      if (manifest.surfaces?.[0] === 'ui') {
        state.lastRun = { pluginRunId, packageId, mode, status: 'awaiting-client', startedAt };
      } else {
        state.currentPackageId = packageId;
        state.runningPackageId = packageId;
        delete state.nextPackageId;
        state.lastRun = {
          pluginRunId,
          packageId,
          mode,
          status: 'succeeded',
          startedAt,
          finishedAt: this.dependencies.now(),
        };
      }
      await writePluginVersionState(pluginRoot, state);
      this.dependencies.lifecycle(pluginId, 'loaded', `version=${manifest.version}; mode=${mode}; run=${pluginRunId}`);
      return {
        id: pluginId,
        packageId,
        pluginRunId,
        mode,
        version: manifest.version,
        toolNames: this.dependencies.registry.getPlugin(pluginId)?.registeredTools ?? [],
        surface: packageSurface(manifest),
      };
    } catch (error) {
      if (registryInstalled) {
        await this.dependencies.registry.removePluginFromRegistry(pluginId).catch(() => false);
      }
      const detail = error instanceof Error ? error.message : String(error);
      delete state.runningPackageId;
      state.nextPackageId = packageId;
      state.lastRun = {
        pluginRunId,
        packageId,
        mode,
        status: 'failed',
        startedAt,
        finishedAt: this.dependencies.now(),
        error: detail,
      };
      await writePluginVersionState(pluginRoot, state);
      this.dependencies.lifecycle(pluginId, 'failed', detail);
      throw error;
    } finally {
      if (watcherWasActive) this.dependencies.registry.resumeWatching();
    }
  }

  async reportUiLoadState(pluginId: string, error?: string): Promise<void> {
    const pluginRoot = path.join(this.dependencies.pluginsDir(), pluginId);
    const state = await this.requireState(pluginRoot);
    const run = state.lastRun;
    const isAwaitingClient = run?.status === 'awaiting-client';
    const isRunningClient = run?.status === 'succeeded'
      && state.runningPackageId === run.packageId;
    if (!isAwaitingClient && !isRunningClient) throw new Error('找不到等待启动的插件');
    const detail = error?.trim();
    if (isRunningClient && !detail) return;
    if (detail) {
      await this.dependencies.registry.removePluginFromRegistry(pluginId).catch(() => false);
      delete state.runningPackageId;
      state.nextPackageId = run.packageId;
      state.lastRun = { ...run, status: 'failed', finishedAt: this.dependencies.now(), error: detail };
      this.dependencies.lifecycle(pluginId, 'failed', detail);
    } else {
      state.currentPackageId = run.packageId;
      state.runningPackageId = run.packageId;
      delete state.nextPackageId;
      state.lastRun = { ...run, status: 'succeeded', finishedAt: this.dependencies.now() };
    }
    await writePluginVersionState(pluginRoot, state);
  }

  async listStates(): Promise<Array<{ pluginRoot: string; state: PluginVersionState }>> {
    return listPluginVersionStates(this.dependencies.pluginsDir());
  }

  async readState(pluginId: string): Promise<PluginVersionState | null> {
    return readPluginVersionState(path.join(this.dependencies.pluginsDir(), pluginId));
  }

  async readPackageManifest(pluginRoot: string, packageId: string): Promise<PluginManifest | null> {
    return readPluginManifest(pluginPackageRoot(pluginRoot, packageId));
  }

  private async requireState(pluginRoot: string): Promise<PluginVersionState> {
    const state = await readPluginVersionState(pluginRoot);
    if (!state) throw new Error('找不到插件版本记录');
    return state;
  }
}
