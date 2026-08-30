import { describe, expect, it, vi } from 'vitest';
import { TurnTraceRecorder } from '../../../../src/host/agent/runtime/turnTrace';
import {
  CapabilityUnitRuntime,
  type CapabilityKey,
  type CapabilityUnit,
} from '../../../../src/host/services/capability/capabilityUnitRuntime';
import { recordCapabilityLifecycle } from '../../../../src/host/services/capability/capabilityLifecycleTrace';

function unit(input: {
  id: string;
  depends?: CapabilityKey[];
  provides?: CapabilityKey[];
  register?: CapabilityUnit['register'];
}): CapabilityUnit {
  return {
    id: input.id,
    type: 'skill',
    depends: input.depends ?? [],
    provides: input.provides ?? [`skill:${input.id}`],
    register: input.register ?? (() => undefined),
  };
}

describe('CapabilityUnitRuntime', () => {
  it('rejects a dependency cycle and reports its concrete path', async () => {
    const runtime = new CapabilityUnitRuntime();
    const a = unit({ id: 'a', depends: ['skill:b'] });
    const b = unit({ id: 'b', depends: ['skill:a'] });

    await expect(runtime.loadAll([a, b])).rejects.toThrow(
      'capability dependency cycle: skill:a -> skill:b -> skill:a',
    );
    expect(runtime.getLoadedUnitIds()).toEqual([]);
  });

  it('rolls back a partial load in strict LIFO order', async () => {
    const order: string[] = [];
    const runtime = new CapabilityUnitRuntime();
    const failing = unit({
      id: 'partial',
      async register(context) {
        await context.register({ apply: () => { order.push('apply-1'); }, inverse: () => { order.push('undo-1'); } });
        await context.register({ apply: () => { order.push('apply-2'); }, inverse: () => { order.push('undo-2'); } });
        throw new Error('third registration failed');
      },
    });

    await expect(runtime.load(failing)).rejects.toThrow('third registration failed');
    expect(order).toEqual(['apply-1', 'apply-2', 'undo-2', 'undo-1']);
    expect(runtime.isLoaded('partial')).toBe(false);
  });

  it('keeps an already loaded sibling active when another unit fails', async () => {
    let siblingRegistered = false;
    const runtime = new CapabilityUnitRuntime();
    await runtime.load(unit({
      id: 'sibling',
      async register(context) {
        await context.register({
          apply: () => { siblingRegistered = true; },
          inverse: () => { siblingRegistered = false; },
        });
      },
    }));

    await expect(runtime.load(unit({ id: 'broken', register: () => { throw new Error('boom'); } })))
      .rejects.toThrow('boom');

    expect(runtime.isLoaded('sibling')).toBe(true);
    expect(siblingRegistered).toBe(true);
  });

  it('records loaded, unloaded, rolled_back, and failed with the real trace event shape', async () => {
    const trace = new TurnTraceRecorder('capability-lifecycle-unit');
    vi.spyOn(trace, 'flush').mockReturnValue(true);
    const runtime = new CapabilityUnitRuntime((data) => recordCapabilityLifecycle(trace, data));

    await runtime.load(unit({ id: 'healthy' }));
    await runtime.unload('healthy');
    await expect(runtime.load(unit({ id: 'broken', register: () => { throw new Error('boom'); } })))
      .rejects.toThrow('boom');

    const events = trace.getEvents().filter((event) => event.type === 'capability_lifecycle');
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.data.action)).toEqual([
      'loaded',
      'unloaded',
      'rolled_back',
      'failed',
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        sessionId: 'capability-lifecycle-unit',
        turnIndex: 0,
        type: 'capability_lifecycle',
        data: { capabilityKey: expect.stringMatching(/^skill:/) },
      });
      expect(typeof event.ts).toBe('number');
    }
  });

  it('accepts plugin units and fails loud on missing declarations, bare keys, and unsupported surfaces', async () => {
    const runtime = new CapabilityUnitRuntime();
    await expect(runtime.load({ ...unit({ id: 'plugin-unit' }), type: 'plugin' }))
      .resolves.toBeUndefined();
    const missing = { ...unit({ id: 'missing' }), depends: undefined } as unknown as CapabilityUnit;
    await expect(runtime.load(missing)).rejects.toThrow('missing required declaration "depends"');

    const bare = {
      ...unit({ id: 'bare' }),
      depends: ['bare-key'] as unknown as CapabilityKey[],
    };
    await expect(runtime.load(bare)).rejects.toThrow('invalid depends key "bare-key"');

    const hook = { ...unit({ id: 'hook' }), type: 'hook' } as unknown as CapabilityUnit;
    await expect(runtime.load(hook)).rejects.toThrow('only unit types "skill" and "plugin" are permitted');
  });
});
