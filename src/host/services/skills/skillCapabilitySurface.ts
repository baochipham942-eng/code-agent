import type { ParsedSkill } from '../../../shared/contract/agentSkill';
import { TurnTraceRecorder } from '../../agent/runtime/turnTrace';
import { createLogger } from '../infra/logger';
import {
  CapabilityUnitRuntime,
  type CapabilityKey,
  type CapabilityUnit,
} from '../capability/capabilityUnitRuntime';
import { recordCapabilityLifecycle } from '../capability/capabilityLifecycleTrace';
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
}
const states = new WeakMap<ToolSearchService, SkillCapabilitySurfaceState>();

function stateFor(toolSearch: ToolSearchService): SkillCapabilitySurfaceState {
  const existing = states.get(toolSearch);
  if (existing) return existing;
  const created = {
    runtime: new CapabilityUnitRuntime(writeLifecycle),
    signatures: new Map<string, string>(),
  };
  states.set(toolSearch, created);
  return created;
}

function declarationForSkill(skill: ParsedSkill, toolSearch: ToolSearchService): CapabilityUnit {
  return {
    id: skill.name,
    type: 'skill',
    depends: skill.depends as unknown as CapabilityKey[],
    provides: skill.provides as unknown as CapabilityKey[],
    async register(context) {
      await context.register({
        apply: () => toolSearch.registerSkill(skill.name, skill.description, skill.aliases),
        inverse: () => { toolSearch.unregisterSkill(skill.name); },
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
  const { runtime, signatures } = stateFor(toolSearch);
  const desired = new Map(skills.map((skill) => [skill.name, skill]));
  const desiredUnits = [...desired.values()].map((skill) => declarationForSkill(skill, toolSearch));
  runtime.validate(desiredUnits);
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
    : additions.map((skill) => declarationForSkill(skill, toolSearch));
  await runtime.loadAll(units);
  for (const skill of additions) signatures.set(skill.name, signature(skill));
}
