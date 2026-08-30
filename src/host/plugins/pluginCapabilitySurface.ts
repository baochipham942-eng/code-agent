import type { PluginManifest } from './types';
import {
  CapabilityUnitRuntime,
  type CapabilityKey,
  type CapabilityLifecycleSink,
  type CapabilityUnit,
} from '../services/capability/capabilityUnitRuntime';

const CAPABILITY_KEY_PATTERN = /^(?:(?:skill|tool|connector|extension):[a-z0-9][a-z0-9._/-]*|plugin:[A-Za-z0-9][A-Za-z0-9._/-]*)$/;

interface PluginCapabilityDeclarationIssue {
  field: 'depends' | 'provides';
  message: string;
}

export function validatePluginCapabilityDeclaration(
  manifest: Record<string, unknown>,
): PluginCapabilityDeclarationIssue[] {
  const issues: PluginCapabilityDeclarationIssue[] = [];
  const id = typeof manifest.id === 'string'
    ? manifest.id
    : typeof manifest.name === 'string' ? manifest.name : undefined;

  for (const field of ['depends', 'provides'] as const) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      issues.push({ field, message: `'${field}' must be an array` });
      continue;
    }
    const strings: string[] = [];
    for (const key of value) {
      if (typeof key !== 'string') {
        issues.push({ field, message: `Each ${field} entry must be a string` });
        continue;
      }
      strings.push(key);
      if (!CAPABILITY_KEY_PATTERN.test(key)) {
        issues.push({
          field,
          message: `Invalid capability key '${key}'; expected a namespaced key such as 'plugin:${id ?? 'example'}'`,
        });
      }
    }
    if (new Set(strings).size !== strings.length) {
      issues.push({ field, message: `'${field}' must not contain duplicate capability keys` });
    }
  }

  if (id && Array.isArray(manifest.provides) && !manifest.provides.includes(`plugin:${id}`)) {
    issues.push({
      field: 'provides',
      message: `'provides' must include the plugin's own capability key 'plugin:${id}'`,
    });
  }
  return issues;
}

export function normalizePluginCapabilityDeclaration(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    depends: manifest.depends ?? [],
    provides: manifest.provides ?? [`plugin:${manifest.id}`],
  };
}

function capabilityUnit(
  manifest: PluginManifest,
  activate: () => void | Promise<void> = () => undefined,
  deactivate: () => void | Promise<void> = () => undefined,
): CapabilityUnit {
  const normalized = normalizePluginCapabilityDeclaration(manifest);
  return {
    id: normalized.id,
    type: 'plugin',
    depends: normalized.depends as CapabilityKey[],
    provides: normalized.provides as CapabilityKey[],
    async register(context) {
      await context.register({ apply: activate, inverse: deactivate });
    },
  };
}

export class PluginCapabilitySurface {
  private readonly runtime: CapabilityUnitRuntime;
  private readonly activeManifests = new Map<string, PluginManifest>();

  constructor(lifecycle?: CapabilityLifecycleSink) {
    this.runtime = new CapabilityUnitRuntime(lifecycle);
  }

  validateCandidate(manifest: PluginManifest): void {
    const manifests = [...this.activeManifests.values()]
      .filter((active) => active.id !== manifest.id)
      .concat(manifest);
    this.runtime.validate(manifests.map((candidate) => capabilityUnit(candidate)));
  }

  validateGraph(manifests: readonly PluginManifest[]): void {
    this.runtime.validate(manifests.map((manifest) => capabilityUnit(manifest)));
  }

  async load(
    manifest: PluginManifest,
    activate: () => void | Promise<void>,
    deactivate: () => void | Promise<void>,
  ): Promise<void> {
    const normalized = normalizePluginCapabilityDeclaration(manifest);
    await this.runtime.load(capabilityUnit(normalized, activate, deactivate));
    this.activeManifests.set(normalized.id, normalized);
  }

  async unload(pluginId: string): Promise<boolean> {
    const unloaded = await this.runtime.unload(pluginId);
    if (unloaded) this.activeManifests.delete(pluginId);
    return unloaded;
  }

  isLoaded(pluginId: string): boolean {
    return this.runtime.isLoaded(pluginId);
  }

  getLoadedPluginIds(): string[] {
    return this.runtime.getLoadedUnitIds();
  }

  getActiveManifests(): PluginManifest[] {
    return [...this.activeManifests.values()];
  }
}
