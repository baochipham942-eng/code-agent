import React, { useSyncExternalStore } from 'react';
import type {
  UiSlotContract,
  UiSlotKind,
  UiSlotReplaceRisk,
  UiSlotScope,
} from '@shared/contract/uiSlots';
import { assertPluginUiRuntimeAdmission } from './pluginUiRuntimeAdmission';

type SlotComponent = React.ComponentType<Record<string, unknown>>;
type Disposer = () => void;
type EffectDisposer = () => void | Promise<void>;

interface SlotDeclaration extends UiSlotContract {
  name: string;
  declaredBy: string;
}

interface SlotRegistration {
  component: SlotComponent;
  failed: boolean;
  generation: number;
  id?: string;
  identity: string;
  key?: string;
  name: string;
  pluginId: string;
  sequence: number;
}

export interface SlotOccupant {
  id?: string;
  key?: string;
  pluginId: string;
  status: 'active' | 'error' | 'shadowed';
}

export interface SlotSnapshot extends SlotDeclaration {
  occupants: SlotOccupant[];
}

export interface DeclareSlotOptions {
  kind: UiSlotKind;
  scope: UiSlotScope;
  props: Readonly<Record<string, string>>;
  declaredBy: string;
  replaceRisk: UiSlotReplaceRisk;
}

export interface RegisterSlotTarget {
  name: string;
  id?: string;
  key?: string;
}

interface Injection {
  callback: () => void | Disposer;
  disposers: Set<Disposer>;
  name: string;
  pluginId: string;
}

interface PluginResources {
  effects: Set<EffectDisposer>;
  styles: Set<HTMLStyleElement>;
}

const FORBIDDEN_DOM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bdocument\s*\.\s*body\b/u, reason: 'document.body' },
  { pattern: /\bwindow\b/u, reason: 'window' },
  { pattern: /\bdocument\s*\.\s*querySelector(?:All)?\s*\(\s*['"`]/u, reason: 'hard-coded DOM selector' },
  { pattern: /\bdocument\s*\.\s*getElementById\s*\(\s*['"`]/u, reason: 'hard-coded DOM selector' },
];

function assertDomSafe(value: object, label: string): void {
  const source = Function.prototype.toString.call(value);
  const violation = FORBIDDEN_DOM_PATTERNS.find(({ pattern }) => pattern.test(source));
  if (violation) {
    throw new Error(`${label} cannot access ${violation.reason}; 插件界面只能使用宿主提供的座位与 props`);
  }
}

class SlotRegistry {
  private declarations = new Map<string, SlotDeclaration>();
  private entries = new Map<string, SlotRegistration>();
  private injections = new Set<Injection>();
  private listeners = new Set<() => void>();
  private pluginResources = new Map<string, PluginResources>();
  private stableSequences = new Map<string, number>();
  private version = 0;
  private nextSequence = 1;
  private activePluginId: string | null = null;
  private registrationCollector: Set<Disposer> | null = null;

  subscribe = (listener: () => void): Disposer => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  declare(name: string, options: DeclareSlotOptions): Disposer {
    const existing = this.declarations.get(name);
    const declaration = { name, ...options };
    if (existing && JSON.stringify(existing) !== JSON.stringify(declaration)) {
      throw new Error(`Slot ${name} is already declared with a different contract`);
    }
    this.declarations.set(name, declaration);
    this.runWaitingInjections(name);
    this.changed();
    return () => {
      if (this.declarations.get(name) !== declaration && existing) return;
      this.declarations.delete(name);
      for (const injection of this.injections) {
        if (injection.name !== name) continue;
        this.disposeInjectionRegistrations(injection);
      }
      this.changed();
    };
  }

  inject(name: string, callback: () => void | Disposer): Disposer {
    const pluginId = this.requirePlugin();
    assertPluginUiRuntimeAdmission(pluginId, name);
    const injection: Injection = { callback, disposers: new Set(), name, pluginId };
    this.injections.add(injection);
    if (this.declarations.has(name)) this.runInjection(injection);
    return () => {
      this.injections.delete(injection);
      this.disposeInjectionRegistrations(injection);
    };
  }

  register(target: RegisterSlotTarget, component: SlotComponent): Disposer {
    const pluginId = this.requirePlugin();
    assertPluginUiRuntimeAdmission(pluginId, target.name);
    const contract = this.declarations.get(target.name);
    if (!contract) throw new Error(`Slot ${target.name} is not declared`);
    if (contract.kind === 'keyed' && !target.key) {
      throw new Error(`Keyed slot ${target.name} requires a key`);
    }
    assertDomSafe(component, `Slot component ${target.name}`);

    const localId = target.id ?? target.key ?? `${this.nextSequence}`;
    const identity = `${pluginId}\u0000${target.name}\u0000${localId}`;
    const existing = this.entries.get(identity);
    const sequence = this.stableSequences.get(identity) ?? this.nextSequence++;
    this.stableSequences.set(identity, sequence);
    const generation = (existing?.generation ?? 0) + 1;
    this.entries.set(identity, {
      component,
      failed: false,
      generation,
      id: target.id,
      identity,
      key: target.key,
      name: target.name,
      pluginId,
      sequence,
    });
    this.changed();

    const dispose = () => {
      if (this.entries.get(identity)?.generation !== generation) return;
      this.entries.delete(identity);
      this.changed();
    };
    this.registrationCollector?.add(dispose);
    return dispose;
  }

  effect(disposer: EffectDisposer): Disposer {
    const resources = this.resourcesFor(this.requirePlugin());
    resources.effects.add(disposer);
    return () => resources.effects.delete(disposer);
  }

  addStyle(cssText: string): Disposer {
    const pluginId = this.requirePlugin();
    const resources = this.resourcesFor(pluginId);
    const style = document.createElement('style');
    style.dataset.pluginUi = pluginId;
    style.textContent = cssText;
    document.head.appendChild(style);
    resources.styles.add(style);
    return () => {
      resources.styles.delete(style);
      style.remove();
    };
  }

  query(name: string): SlotSnapshot | undefined {
    const declaration = this.declarations.get(name);
    if (!declaration) return undefined;
    const visible = new Set(this.visibleEntries(name).map((entry) => entry.identity));
    const occupants = this.entriesFor(name).map((entry): SlotOccupant => ({
      id: entry.id,
      key: entry.key,
      pluginId: entry.pluginId,
      status: entry.failed ? 'error' : visible.has(entry.identity) ? 'active' : 'shadowed',
    }));
    return { ...declaration, props: { ...declaration.props }, occupants };
  }

  entriesFor(name: string): SlotRegistration[] {
    return [...this.entries.values()]
      .filter((entry) => entry.name === name)
      .sort((left, right) => left.sequence - right.sequence);
  }

  visibleEntries(name: string): SlotRegistration[] {
    const declaration = this.declarations.get(name);
    if (!declaration) return [];
    const entries = this.entriesFor(name);
    if (declaration.kind === 'list' || declaration.kind === 'chain') return entries;
    if (declaration.kind === 'single') {
      const winner = entries.filter((entry) => !entry.failed).at(-1);
      return winner ? [winner] : [];
    }
    const winners = new Map<string, SlotRegistration>();
    for (const entry of entries) {
      if (!entry.failed) winners.set(entry.key ?? '', entry);
    }
    return [...winners.values()].sort((left, right) => left.sequence - right.sequence);
  }

  fail(identity: string): void {
    const entry = this.entries.get(identity);
    if (!entry || entry.failed) return;
    entry.failed = true;
    this.changed();
  }

  async activate(pluginId: string, activate: () => unknown | Promise<unknown>): Promise<void> {
    assertDomSafe(activate, `Plugin ${pluginId} activate()`);
    await this.unload(pluginId);
    let result: unknown;
    try {
      result = await this.runOwned(pluginId, activate);
      if (result !== undefined) {
        throw new Error('插件 activate() 不能返回 React 元素或组件；界面只能通过 slots.register 注册');
      }
    } catch (error) {
      await this.unload(pluginId);
      throw error;
    }
  }

  async unload(pluginId: string): Promise<void> {
    for (const injection of [...this.injections]) {
      if (injection.pluginId !== pluginId) continue;
      this.injections.delete(injection);
      this.disposeInjectionRegistrations(injection);
    }
    for (const [identity, entry] of this.entries) {
      if (entry.pluginId === pluginId) this.entries.delete(identity);
    }
    const resources = this.pluginResources.get(pluginId);
    if (resources) {
      for (const effect of [...resources.effects].reverse()) {
        try {
          await effect();
        } catch (error) {
          console.error(`[SlotRegistry] plugin effect cleanup failed: ${pluginId}`, error);
        }
      }
      for (const style of resources.styles) style.remove();
      this.pluginResources.delete(pluginId);
    }
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  private resourcesFor(pluginId: string): PluginResources {
    const existing = this.pluginResources.get(pluginId);
    if (existing) return existing;
    const created = { effects: new Set<EffectDisposer>(), styles: new Set<HTMLStyleElement>() };
    this.pluginResources.set(pluginId, created);
    return created;
  }

  private requirePlugin(): string {
    if (!this.activePluginId) {
      throw new Error('slots API can only be used while a plugin is activating or an injection callback is running');
    }
    return this.activePluginId;
  }

  private async runOwned<T>(pluginId: string, callback: () => T | Promise<T>): Promise<T> {
    const previous = this.activePluginId;
    this.activePluginId = pluginId;
    try {
      return await callback();
    } finally {
      this.activePluginId = previous;
    }
  }

  private runWaitingInjections(name: string): void {
    for (const injection of this.injections) {
      if (injection.name === name && injection.disposers.size === 0) this.runInjection(injection);
    }
  }

  private runInjection(injection: Injection): void {
    const previousOwner = this.activePluginId;
    const previousCollector = this.registrationCollector;
    const collector = new Set<Disposer>();
    this.activePluginId = injection.pluginId;
    this.registrationCollector = collector;
    try {
      const returned = injection.callback();
      if (typeof returned === 'function') collector.add(returned);
      injection.disposers = collector;
    } finally {
      this.registrationCollector = previousCollector;
      this.activePluginId = previousOwner;
    }
  }

  private disposeInjectionRegistrations(injection: Injection): void {
    for (const dispose of injection.disposers) dispose();
    injection.disposers.clear();
  }
}

const registry = new SlotRegistry();

export const slots = Object.freeze({
  inject: (name: string, callback: () => void | Disposer): Disposer => registry.inject(name, callback),
  register: (target: RegisterSlotTarget, component: SlotComponent): Disposer => registry.register(target, component),
  effect: (disposer: EffectDisposer): Disposer => registry.effect(disposer),
  addStyle: (cssText: string): Disposer => registry.addStyle(cssText),
  get: (name: string): SlotSnapshot | undefined => registry.query(name),
});

export function declareSlot(name: string, options: DeclareSlotOptions): Disposer {
  return registry.declare(name, options);
}

export function activatePluginUi(pluginId: string, activate: () => unknown | Promise<unknown>): Promise<void> {
  return registry.activate(pluginId, activate);
}

export function unloadPluginUi(pluginId: string): Promise<void> {
  return registry.unload(pluginId);
}

class ShadowBoundary extends React.Component<{
  entry: SlotRegistration;
  children: React.ReactNode;
}, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(): void {
    registry.fail(this.props.entry.identity);
  }

  render(): React.ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

class AdditiveBoundary extends React.Component<{
  entry: SlotRegistration;
  children: React.ReactNode;
}, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(): void {
    registry.fail(this.props.entry.identity);
  }

  render(): React.ReactNode {
    if (this.state.crashed) {
      return <div role="alert" data-slot-error={this.props.entry.name}>插件内容加载失败</div>;
    }
    return this.props.children;
  }
}

export interface SlotProps {
  name: string;
  props?: Record<string, unknown>;
  fallback?: React.ReactNode;
}

export const Slot: React.FC<SlotProps> = ({ name, props = {}, fallback = null }) => {
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  const declaration = registry.query(name);
  if (!declaration) return null;
  const entries = registry.visibleEntries(name);
  if (entries.length === 0) return <>{fallback}</>;
  const additive = declaration.kind === 'list' || declaration.kind === 'chain';
  return (
    <>
      {entries.map((entry) => {
        if (additive && entry.failed) {
          return <div key={entry.identity} role="alert" data-slot-error={name}>插件内容加载失败</div>;
        }
        const Component = entry.component;
        const content = <Component {...props} />;
        return additive ? (
          <AdditiveBoundary key={entry.identity} entry={entry}>{content}</AdditiveBoundary>
        ) : (
          <ShadowBoundary key={entry.identity} entry={entry}>{content}</ShadowBoundary>
        );
      })}
    </>
  );
};
