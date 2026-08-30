import type { CapabilityPackagePermission } from '../../../shared/contract/capabilityPackage';
import type {
  BundledHostCapabilityId,
  BundledHostCapabilityState,
} from '../../../shared/contract/bundledHostCapability';
import { getUserDataPath } from '../../platform';
import { voiceLiveCapabilityDescriptor } from '../voice/voiceLiveCapability';
import { voiceInputCapabilityDescriptor } from '../speech/voiceInputCapability';
import { recordBundledHostCapabilityLifecycle } from './capabilityPackageLifecycle';
import {
  registerTurnOutcomeResolver,
  registerUserQuestionRoute,
  type HostCapabilityCleanup,
  type TurnOutcomeResolver,
  type UserQuestionRoute,
} from './hostCapabilityPorts';
import {
  projectBundledHostCapabilityState,
  readBundledHostCapabilityInstallSnapshot,
  restoreBundledHostCapabilityInstallSnapshot,
  writeBundledHostCapabilityInstallState,
} from './bundledHostCapabilityInstallState';

type PlaceholderContribution = Readonly<Record<string, unknown>>;

interface HostCapabilityContext {
  registerIpcHandler: (contribution: PlaceholderContribution) => HostCapabilityCleanup;
  registerWebRoute: (contribution: PlaceholderContribution) => HostCapabilityCleanup;
  registerWebSocketUpgrade: (contribution: PlaceholderContribution) => HostCapabilityCleanup;
  registerStartupTask: (contribution: PlaceholderContribution) => HostCapabilityCleanup;
  registerProviderAction: (contribution: PlaceholderContribution) => HostCapabilityCleanup;
  registerTurnOutcomeResolver: (resolver: TurnOutcomeResolver) => HostCapabilityCleanup;
  registerUserQuestionRoute: (route: UserQuestionRoute) => HostCapabilityCleanup;
  publishRendererCapabilityState: () => void;
}

export interface BundledHostCapabilityDescriptor {
  id: BundledHostCapabilityId;
  version: string;
  dependencies: BundledHostCapabilityId[];
  permissions: CapabilityPackagePermission[];
  activate: (host: HostCapabilityContext) => Promise<HostCapabilityCleanup>;
}

type LifecycleRecorder = typeof recordBundledHostCapabilityLifecycle;

interface BundledHostCapabilityRegistryOptions {
  dataDir?: string;
  descriptors?: readonly BundledHostCapabilityDescriptor[];
  lifecycle?: LifecycleRecorder;
}

interface ActiveCapability {
  cleanup: HostCapabilityCleanup;
}

const DEFAULT_DESCRIPTORS = [
  voiceLiveCapabilityDescriptor,
  voiceInputCapabilityDescriptor,
] as const;

function asErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupAll(cleanups: readonly HostCapabilityCleanup[]): Promise<void> {
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      await cleanups[index]();
    } catch {
      // Cleanup is best-effort here; the original activation error stays authoritative.
    }
  }
}

export class BundledHostCapabilityRegistry {
  private readonly dataDir: string;
  private readonly descriptors: Map<BundledHostCapabilityId, BundledHostCapabilityDescriptor>;
  private readonly lifecycle: LifecycleRecorder;
  private readonly active = new Map<BundledHostCapabilityId, ActiveCapability>();
  private readonly published = new Set<BundledHostCapabilityId>();
  private initialized = false;

  constructor(options: BundledHostCapabilityRegistryOptions = {}) {
    this.dataDir = options.dataDir ?? getUserDataPath();
    this.descriptors = new Map(
      (options.descriptors ?? DEFAULT_DESCRIPTORS).map((descriptor) => [descriptor.id, descriptor]),
    );
    this.lifecycle = options.lifecycle ?? recordBundledHostCapabilityLifecycle;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const ordered = this.activationOrder();
    for (const descriptor of ordered) {
      const snapshot = await readBundledHostCapabilityInstallSnapshot(this.dataDir, descriptor.id);
      if (snapshot.record?.state === 'removed') continue;
      if (snapshot.record?.state === 'installed') {
        await this.activateInstalled(descriptor);
      } else {
        await this.install(descriptor.id);
      }
    }
    this.initialized = true;
  }

  async install(id: BundledHostCapabilityId): Promise<void> {
    const descriptor = this.requireDescriptor(id);
    if (this.active.has(id)) return;
    for (const dependency of descriptor.dependencies) {
      if (!this.active.has(dependency)) await this.install(dependency);
    }
    const previous = await readBundledHostCapabilityInstallSnapshot(this.dataDir, id);
    const baseRevision = previous.record?.revision ?? 0;
    try {
      await writeBundledHostCapabilityInstallState(
        this.dataDir,
        id,
        'staged',
        descriptor.version,
        baseRevision + 1,
      );
      await this.activateDescriptor(descriptor);
      await writeBundledHostCapabilityInstallState(
        this.dataDir,
        id,
        'installed',
        descriptor.version,
        baseRevision + 2,
      );
      this.lifecycle(id, 'loaded', `version=${descriptor.version}`);
    } catch (error) {
      const active = this.active.get(id);
      if (active) {
        try {
          await active.cleanup();
        } catch {
          // State restoration and lifecycle evidence still have to run.
        } finally {
          this.active.delete(id);
        }
      }
      await restoreBundledHostCapabilityInstallSnapshot(this.dataDir, id, previous);
      this.lifecycle(id, 'failed', asErrorDetail(error));
      this.lifecycle(id, 'rolled_back', previous.record ? 'restored previous state' : 'restored default state');
      throw error;
    }
  }

  async uninstall(id: BundledHostCapabilityId): Promise<void> {
    const descriptor = this.requireDescriptor(id);
    for (const candidate of this.descriptors.values()) {
      if (candidate.dependencies.includes(id) && this.active.has(candidate.id)) {
        throw new Error(`${id} is required by ${candidate.id}`);
      }
    }
    const active = this.active.get(id);
    if (active) await active.cleanup();
    this.active.delete(id);
    const previous = await readBundledHostCapabilityInstallSnapshot(this.dataDir, id);
    await writeBundledHostCapabilityInstallState(
      this.dataDir,
      id,
      'removed',
      descriptor.version,
      (previous.record?.revision ?? 0) + 1,
    );
    this.lifecycle(id, 'unloaded', `version=${descriptor.version}`);
  }

  async listStates(): Promise<BundledHostCapabilityState[]> {
    const result: BundledHostCapabilityState[] = [];
    for (const descriptor of this.activationOrder()) {
      const snapshot = await readBundledHostCapabilityInstallSnapshot(this.dataDir, descriptor.id);
      const projected = projectBundledHostCapabilityState(descriptor.id, descriptor.version, snapshot);
      result.push({
        ...projected,
        installed: projected.installed && this.published.has(descriptor.id),
      });
    }
    return result;
  }

  private async activateInstalled(descriptor: BundledHostCapabilityDescriptor): Promise<void> {
    try {
      await this.activateDescriptor(descriptor);
      this.lifecycle(descriptor.id, 'loaded', `version=${descriptor.version}; startup`);
    } catch (error) {
      this.lifecycle(descriptor.id, 'failed', asErrorDetail(error));
      this.lifecycle(descriptor.id, 'rolled_back', 'startup activation contributions removed');
      throw error;
    }
  }

  private async activateDescriptor(descriptor: BundledHostCapabilityDescriptor): Promise<void> {
    const contributionCleanups: HostCapabilityCleanup[] = [];
    const track = (cleanup: HostCapabilityCleanup): HostCapabilityCleanup => {
      let active = true;
      const once = async (): Promise<void> => {
        if (!active) return;
        active = false;
        await cleanup();
      };
      contributionCleanups.push(once);
      return once;
    };
    const unsupported = (surface: string): never => {
      throw new Error(`${surface} contributions are reserved for voice split P1`);
    };
    const host: HostCapabilityContext = {
      registerIpcHandler: () => unsupported('IPC'),
      registerWebRoute: () => unsupported('web route'),
      registerWebSocketUpgrade: () => unsupported('WebSocket upgrade'),
      registerStartupTask: () => unsupported('startup task'),
      registerProviderAction: () => unsupported('provider action'),
      registerTurnOutcomeResolver: (resolver) => track(registerTurnOutcomeResolver(resolver)),
      registerUserQuestionRoute: (route) => track(registerUserQuestionRoute(route)),
      publishRendererCapabilityState: () => {
        this.published.add(descriptor.id);
        track(() => { this.published.delete(descriptor.id); });
      },
    };
    try {
      const descriptorCleanup = await descriptor.activate(host);
      this.active.set(descriptor.id, {
        cleanup: async () => {
          try {
            await descriptorCleanup();
          } finally {
            await cleanupAll(contributionCleanups);
          }
        },
      });
    } catch (error) {
      await cleanupAll(contributionCleanups);
      throw error;
    }
  }

  private activationOrder(): BundledHostCapabilityDescriptor[] {
    const ordered: BundledHostCapabilityDescriptor[] = [];
    const visiting = new Set<BundledHostCapabilityId>();
    const visited = new Set<BundledHostCapabilityId>();
    const visit = (descriptor: BundledHostCapabilityDescriptor): void => {
      if (visited.has(descriptor.id)) return;
      if (visiting.has(descriptor.id)) throw new Error(`cyclic bundled host capability dependency: ${descriptor.id}`);
      visiting.add(descriptor.id);
      for (const dependencyId of descriptor.dependencies) visit(this.requireDescriptor(dependencyId));
      visiting.delete(descriptor.id);
      visited.add(descriptor.id);
      ordered.push(descriptor);
    };
    for (const descriptor of this.descriptors.values()) visit(descriptor);
    return ordered;
  }

  private requireDescriptor(id: BundledHostCapabilityId): BundledHostCapabilityDescriptor {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) throw new Error(`unknown bundled host capability: ${id}`);
    return descriptor;
  }
}

let registry: BundledHostCapabilityRegistry | null = null;

export function getBundledHostCapabilityRegistry(): BundledHostCapabilityRegistry {
  registry ??= new BundledHostCapabilityRegistry();
  return registry;
}

export async function initializeBundledHostCapabilities(): Promise<void> {
  await getBundledHostCapabilityRegistry().initialize();
}
