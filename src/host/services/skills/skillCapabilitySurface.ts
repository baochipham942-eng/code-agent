import type { ParsedSkill } from '../../../shared/contract/agentSkill';
import { TurnTraceRecorder } from '../../agent/runtime/turnTrace';
import { createLogger } from '../infra/logger';
import {
  CapabilityUnitRuntime,
  type CapabilityKey,
  type CapabilityUnit,
} from '../capability/capabilityUnitRuntime';
import { recordCapabilityLifecycle } from '../capability/capabilityLifecycleTrace';
import { CapabilityBroker } from '../capability/capabilityBroker';
import type { ToolSearchService } from '../toolSearch';

const logger = createLogger('SkillCapabilitySurface');
let trace: TurnTraceRecorder | null = null;

function writeLifecycle(data: Parameters<typeof recordCapabilityLifecycle>[1]): void {
  try {
    trace ??= new TurnTraceRecorder('capability-runtime');
    recordCapabilityLifecycle(trace, data);
  } catch (error) {
    logger.warn('capability lifecycle recorder initialization failed', {
      capabilityKey: data.capabilityKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
interface SkillCapabilitySurfaceState {
  runtime: CapabilityUnitRuntime;
  signatures: Map<string, string>;
  registryBroker: CapabilityBroker<SkillRegistryCapability>;
}
interface SkillRegistryCapability {
  register(name: string, description: string, aliases?: string[]): void;
  unregister(name: string): void;
}
const SKILL_REGISTRY_CAPABILITY_KEY: CapabilityKey = 'skill:neo/registration';
const states = new WeakMap<ToolSearchService, SkillCapabilitySurfaceState>();

function stateFor(toolSearch: ToolSearchService): SkillCapabilitySurfaceState {
  const existing = states.get(toolSearch);
  if (existing) return existing;
  const created = {
    runtime: new CapabilityUnitRuntime(writeLifecycle),
    signatures: new Map<string, string>(),
    registryBroker: new CapabilityBroker(SKILL_REGISTRY_CAPABILITY_KEY, [{
      id: 'tool-search-registry',
      isAvailable: () => true,
      implementation: {
        register: (name: string, description: string, aliases?: string[]) => (
          toolSearch.registerSkill(name, description, aliases)
        ),
        unregister: (name: string) => { toolSearch.unregisterSkill(name); },
      },
    }]),
  };
  states.set(toolSearch, created);
  return created;
}

function declarationForSkill(
  skill: ParsedSkill,
  registryBroker: CapabilityBroker<SkillRegistryCapability>,
): CapabilityUnit {
  return {
    id: skill.name,
    type: 'skill',
    depends: skill.depends as unknown as CapabilityKey[],
    provides: skill.provides as unknown as CapabilityKey[],
    async register(context) {
      const registry = registryBroker.resolve(SKILL_REGISTRY_CAPABILITY_KEY);
      await context.register({
        apply: () => registry.register(skill.name, skill.description, skill.aliases),
        inverse: () => { registry.unregister(skill.name); },
      });
    },
  };
}

function signature(skill: ParsedSkill): string {
  return JSON.stringify({
    description: skill.description,
    aliases: skill.aliases ?? [],
    depends: skill.depends,
    provides: skill.provides,
  });
}

/** Reconcile the production ToolSearch skill table through reversible per-skill units. */
export async function synchronizeSkillCapabilitySurface(
  skills: readonly ParsedSkill[],
  toolSearch: ToolSearchService,
): Promise<void> {
  const { runtime, signatures, registryBroker } = stateFor(toolSearch);
  const desired = new Map(skills.map((skill) => [skill.name, skill]));
  const desiredUnits = [...desired.values()].map((skill) => declarationForSkill(skill, registryBroker));
  const changed = new Set<string>();
  for (const [name, skill] of desired) {
    if (runtime.isLoaded(name) && signatures.get(name) !== signature(skill)) changed.add(name);
  }

  const loadedIds = runtime.getLoadedUnitIds();
  const rebuild = changed.size > 0 || loadedIds.some((name) => !desired.has(name));
  for (const name of loadedIds.reverse()) {
    if (rebuild) {
      await runtime.unload(name);
      signatures.delete(name);
    }
  }

  const additions = [...desired.values()].filter((skill) => !runtime.isLoaded(skill.name));
  const units = rebuild
    ? desiredUnits
    : additions.map((skill) => declarationForSkill(skill, registryBroker));
  // 逐技能隔离加载：单个 skill 声明非法或注册失败只 warn 跳过自身，不拖垮整批注册。
  const available = new Set<CapabilityKey>();
  for (const id of runtime.getLoadedUnitIds()) {
    const skill = desired.get(id);
    if (!skill) continue;
    for (const key of skill.provides ?? []) available.add(key as CapabilityKey);
  }
  const pending = new Map(units.map((unit) => [unit.id, unit]));
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, unit] of pending) {
      if (!unit.depends.every((key) => available.has(key))) continue;
      try {
        await runtime.load(unit);
        for (const key of unit.provides) available.add(key);
      } catch (error) {
        logger.warn('Failed to register skill capability unit; skipping', {
          skill: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) {
      // 剩余 unit 的依赖在本批内无解（provider 缺失或已被跳过），逐个告警后放弃。
      for (const [id, unit] of pending) {
        logger.warn('Failed to register skill capability unit; skipping (unsatisfiable dependencies)', {
          skill: id,
          depends: [...unit.depends],
        });
      }
      pending.clear();
    }
  }
  for (const skill of additions) {
    if (runtime.isLoaded(skill.name)) signatures.set(skill.name, signature(skill));
  }
}
