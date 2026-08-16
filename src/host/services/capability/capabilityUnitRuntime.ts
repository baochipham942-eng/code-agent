import type { TraceEventDataMap } from '../../agent/runtime/turnTrace';

const CAPABILITY_KEY_PATTERN = /^(skill|tool|plugin|connector|extension):[a-z0-9][a-z0-9._/-]*$/;

type CapabilityUnitType = 'skill';
export type CapabilityKey = `${'skill' | 'tool' | 'plugin' | 'connector' | 'extension'}:${string}`;
export type CapabilityLifecycleData = TraceEventDataMap['capability_lifecycle'];
export type CapabilityLifecycleSink = (data: CapabilityLifecycleData) => void;
export type CapabilityInverse = () => void | Promise<void>;

interface CapabilityRegistration {
  apply: () => void | Promise<void>;
  inverse: CapabilityInverse;
}

interface CapabilityRegistrationContext {
  register(registration: CapabilityRegistration): Promise<void>;
}

export interface CapabilityUnit {
  id: string;
  type: CapabilityUnitType;
  depends: readonly CapabilityKey[];
  provides: readonly CapabilityKey[];
  register(context: CapabilityRegistrationContext): void | Promise<void>;
}

interface LoadedCapabilityUnit {
  unit: CapabilityUnit;
  inverses: CapabilityInverse[];
}

class CapabilityUnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityUnitError';
  }
}

function unitLabel(unit: Pick<CapabilityUnit, 'type' | 'id'>): string {
  return `${unit.type}:${unit.id}`;
}

function assertNamespacedKey(key: string, field: string, unit: CapabilityUnit): asserts key is CapabilityKey {
  if (!CAPABILITY_KEY_PATTERN.test(key)) {
    throw new CapabilityUnitError(
      `${unitLabel(unit)} has invalid ${field} key "${key}"; expected a namespaced key such as "skill:ppt"`,
    );
  }
}

function validateCapabilityUnit(unit: CapabilityUnit): void {
  if (unit.type !== 'skill') {
    throw new CapabilityUnitError(
      `${unitLabel(unit)} is not an exchangeable surface; P2 only permits unit type "skill"`,
    );
  }
  if (!Array.isArray(unit.depends)) {
    throw new CapabilityUnitError(`${unitLabel(unit)} is missing required declaration "depends"`);
  }
  if (!Array.isArray(unit.provides)) {
    throw new CapabilityUnitError(`${unitLabel(unit)} is missing required declaration "provides"`);
  }
  if (unit.provides.length === 0) {
    throw new CapabilityUnitError(`${unitLabel(unit)} must declare at least one provided capability key`);
  }
  for (const key of unit.depends as readonly unknown[]) {
    if (typeof key !== 'string') {
      throw new CapabilityUnitError(`${unitLabel(unit)} has non-string depends key`);
    }
    assertNamespacedKey(key, 'depends', unit);
  }
  for (const key of unit.provides as readonly unknown[]) {
    if (typeof key !== 'string') {
      throw new CapabilityUnitError(`${unitLabel(unit)} has non-string provides key`);
    }
    assertNamespacedKey(key, 'provides', unit);
  }
  if (new Set(unit.depends).size !== unit.depends.length) {
    throw new CapabilityUnitError(`${unitLabel(unit)} declares duplicate depends keys`);
  }
  if (new Set(unit.provides).size !== unit.provides.length) {
    throw new CapabilityUnitError(`${unitLabel(unit)} declares duplicate provides keys`);
  }
}

function findDependencyCycle(units: readonly CapabilityUnit[]): string[] | null {
  const providerByKey = new Map<CapabilityKey, CapabilityUnit>();
  for (const unit of units) {
    for (const key of unit.provides) providerByKey.set(key, unit);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: CapabilityUnit[] = [];

  const visit = (unit: CapabilityUnit): string[] | null => {
    const label = unitLabel(unit);
    if (visited.has(label)) return null;
    if (visiting.has(label)) {
      const start = stack.findIndex((candidate) => unitLabel(candidate) === label);
      return [...stack.slice(start).map(unitLabel), label];
    }
    visiting.add(label);
    stack.push(unit);
    for (const key of unit.depends) {
      const provider = providerByKey.get(key);
      if (!provider) continue;
      const cycle = visit(provider);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(label);
    visited.add(label);
    return null;
  };

  for (const unit of units) {
    const cycle = visit(unit);
    if (cycle) return cycle;
  }
  return null;
}

function validateGraph(units: readonly CapabilityUnit[], externalKeys: ReadonlySet<CapabilityKey>): void {
  const providerByKey = new Map<CapabilityKey, CapabilityUnit>();
  for (const unit of units) {
    validateCapabilityUnit(unit);
    for (const key of unit.provides) {
      const existing = providerByKey.get(key);
      if (existing) {
        throw new CapabilityUnitError(
          `capability key "${key}" has multiple providers: ${unitLabel(existing)} and ${unitLabel(unit)}`,
        );
      }
      providerByKey.set(key, unit);
    }
  }
  for (const unit of units) {
    const missing = unit.depends.filter((key) => !providerByKey.has(key) && !externalKeys.has(key));
    if (missing.length > 0) {
      throw new CapabilityUnitError(`${unitLabel(unit)} is missing dependencies: ${missing.join(', ')}`);
    }
  }
  const cycle = findDependencyCycle(units);
  if (cycle) throw new CapabilityUnitError(`capability dependency cycle: ${cycle.join(' -> ')}`);
}

export class CapabilityUnitRuntime {
  private readonly loaded = new Map<string, LoadedCapabilityUnit>();

  constructor(
    private readonly lifecycle: CapabilityLifecycleSink = () => undefined,
    private readonly externalKeys: ReadonlySet<CapabilityKey> = new Set(),
  ) {}

  getLoadedUnitIds(): string[] {
    return [...this.loaded.keys()];
  }

  isLoaded(id: string): boolean {
    return this.loaded.has(id);
  }

  validate(units: readonly CapabilityUnit[]): void {
    try {
      validateGraph(units, this.externalKeys);
    } catch (error) {
      if (units[0]) this.emit(units[0], 'failed', error);
      throw error;
    }
  }

  async load(unit: CapabilityUnit): Promise<void> {
    if (this.loaded.has(unit.id)) return;
    const graph = [...this.loaded.values()].map((entry) => entry.unit).concat(unit);
    try {
      validateGraph(graph, this.externalKeys);
    } catch (error) {
      this.emit(unit, 'failed', error);
      throw error;
    }

    const inverses: CapabilityInverse[] = [];
    const context: CapabilityRegistrationContext = {
      register: async ({ apply, inverse }) => {
        await apply();
        inverses.push(inverse);
      },
    };
    try {
      await unit.register(context);
      this.loaded.set(unit.id, { unit, inverses });
      this.emit(unit, 'loaded');
    } catch (error) {
      const rollbackErrors = await this.rollback(unit, inverses);
      this.emit(unit, 'failed', error);
      const cause = error instanceof Error ? error.message : String(error);
      const suffix = rollbackErrors.length > 0 ? `; rollback errors: ${rollbackErrors.join('; ')}` : '';
      throw new CapabilityUnitError(`${unitLabel(unit)} failed to load: ${cause}${suffix}`);
    }
  }

  async loadAll(units: readonly CapabilityUnit[]): Promise<void> {
    this.validate([...this.loaded.values()].map((entry) => entry.unit).concat(units));
    const pending = new Map(units.map((unit) => [unit.id, unit]));
    while (pending.size > 0) {
      let progressed = false;
      for (const [id, unit] of pending) {
        const available = new Set<CapabilityKey>(this.externalKeys);
        for (const entry of this.loaded.values()) {
          for (const key of entry.unit.provides) available.add(key);
        }
        if (!unit.depends.every((key) => available.has(key))) continue;
        await this.load(unit);
        pending.delete(id);
        progressed = true;
      }
      if (!progressed) {
        throw new CapabilityUnitError(`unable to activate capability units: ${[...pending.keys()].join(', ')}`);
      }
    }
  }

  async unload(id: string): Promise<boolean> {
    const entry = this.loaded.get(id);
    if (!entry) return false;
    const provided = new Set(entry.unit.provides);
    const dependents = [...this.loaded.values()]
      .filter((candidate) => candidate.unit.id !== id && candidate.unit.depends.some((key) => provided.has(key)))
      .map((candidate) => unitLabel(candidate.unit));
    if (dependents.length > 0) {
      const error = new CapabilityUnitError(
        `${unitLabel(entry.unit)} cannot unload while dependents are active: ${dependents.join(', ')}`,
      );
      this.emit(entry.unit, 'failed', error);
      throw error;
    }
    const errors = await this.runInverses(entry.inverses);
    if (errors.length > 0) {
      const error = new CapabilityUnitError(`${unitLabel(entry.unit)} failed to unload: ${errors.join('; ')}`);
      this.emit(entry.unit, 'failed', error);
      throw error;
    }
    this.loaded.delete(id);
    this.emit(entry.unit, 'unloaded');
    return true;
  }

  private async rollback(unit: CapabilityUnit, inverses: readonly CapabilityInverse[]): Promise<string[]> {
    const errors = await this.runInverses(inverses);
    this.emit(unit, 'rolled_back', errors.length > 0 ? errors.join('; ') : undefined);
    return errors;
  }

  private async runInverses(inverses: readonly CapabilityInverse[]): Promise<string[]> {
    const errors: string[] = [];
    for (let index = inverses.length - 1; index >= 0; index -= 1) {
      try {
        await inverses[index]();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return errors;
  }

  private emit(unit: CapabilityUnit, action: CapabilityLifecycleData['action'], error?: unknown): void {
    const providedKey: unknown = Array.isArray(unit.provides) ? unit.provides[0] : undefined;
    this.lifecycle({
      capabilityKey: typeof providedKey === 'string' ? providedKey : `${unit.type}:${unit.id}`,
      action,
      ...(error === undefined
        ? {}
        : { detail: error instanceof Error ? error.message : String(error) }),
    });
  }
}
