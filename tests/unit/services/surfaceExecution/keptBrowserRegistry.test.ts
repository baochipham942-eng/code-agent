import { describe, expect, it, vi } from 'vitest';
import {
  KeptBrowserRegistry,
  type KeptBrowserPoolFacade,
} from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';

function createFakePool() {
  const released: string[] = [];
  const keptFlags = new Map<string, boolean>();
  const pool: KeptBrowserPoolFacade = {
    setKept: vi.fn((key: string, kept: boolean) => keptFlags.set(key, kept)),
    releaseAgent: vi.fn(async (key: string) => {
      released.push(key);
    }),
  };
  return { pool, released, keptFlags };
}

function createFakeService() {
  const listeners = new Set<(reason: string) => void>();
  return {
    onSessionChanged: vi.fn((listener: (reason: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: (reason: string) => {
      for (const listener of listeners) listener(reason);
    },
    listenerCount: () => listeners.size,
  };
}

function baseInput(overrides: Partial<{ conversationId: string; serviceKey: string; url: string }> = {}) {
  return {
    conversationId: overrides.conversationId ?? 'conversation-a',
    serviceKey: overrides.serviceKey ?? 'surface-key-1',
    url: overrides.url ?? 'https://example.test/result',
    title: 'Result',
    browserService: createFakeService(),
  };
}

describe('KeptBrowserRegistry (N-BROWSER-KEEP-RESULT-PAGE)', () => {
  it('registers a kept entry and reports the three-state snapshot', () => {
    const { pool } = createFakePool();
    const registry = new KeptBrowserRegistry(pool, () => 1000);
    const input = baseInput();

    const entry = registry.register(input);

    expect(entry).toEqual({
      conversationId: 'conversation-a',
      serviceKey: 'surface-key-1',
      url: 'https://example.test/result',
      title: 'Result',
      keptAt: 1000,
      state: 'kept',
    });
    expect(registry.getAlive('conversation-a')?.serviceKey).toBe('surface-key-1');
    expect(registry.isKeptServiceAlive('surface-key-1')).toBe(true);
    expect(registry.isKeptServiceAlive('surface-other')).toBe(false);
    expect(registry.snapshot('conversation-a')).toEqual({
      state: 'kept',
      url: 'https://example.test/result',
      title: 'Result',
    });
    expect(registry.snapshot('conversation-b')).toEqual({ state: 'none', url: null, title: null });
    expect(pool.setKept).toHaveBeenCalledWith('surface-key-1', true);
  });

  it('flips the entry to closed (URL remembered) on the service close/crashed event and frees the pool slot', () => {
    const { pool, released } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const input = baseInput();
    registry.register(input);

    input.browserService.emit('page_load');
    expect(registry.getAlive('conversation-a')).not.toBeNull();

    input.browserService.emit('close');
    expect(registry.getAlive('conversation-a')).toBeNull();
    expect(registry.snapshot('conversation-a')).toEqual({
      state: 'closed',
      url: 'https://example.test/result',
      title: 'Result',
    });
    expect(released).toEqual(['surface-key-1']);
    expect(pool.setKept).toHaveBeenCalledWith('surface-key-1', false);

    input.browserService.emit('crashed');
    expect(registry.snapshot('conversation-a').state).toBe('closed');
  });

  it('a newer keep closes the older kept window (one kept window per conversation)', () => {
    const { pool, released } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const first = baseInput({ serviceKey: 'surface-key-1' });
    registry.register(first);
    const second = baseInput({ serviceKey: 'surface-key-2', url: 'https://example.test/next' });
    registry.register(second);

    expect(released).toEqual(['surface-key-1']);
    // 旧窗的 close 事件不会把新条目翻 closed（serviceKey 捕获在注册时）。
    first.browserService.emit('close');
    expect(registry.getAlive('conversation-a')?.serviceKey).toBe('surface-key-2');
    expect(registry.snapshot('conversation-a')).toEqual({
      state: 'kept',
      url: 'https://example.test/next',
      title: 'Result',
    });
  });

  it('re-keeping the same service refreshes url/title without closing the window', () => {
    const { pool } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    const service = createFakeService();
    registry.register({
      conversationId: 'conversation-a',
      serviceKey: 'surface-key-1',
      url: 'https://example.test/before',
      title: 'Before',
      browserService: service,
    });

    registry.register({
      conversationId: 'conversation-a',
      serviceKey: 'surface-key-1',
      url: 'https://example.test/after',
      title: 'After',
      browserService: service,
    });

    expect(registry.getAlive('conversation-a')?.url).toBe('https://example.test/after');
    expect(pool.releaseAgent).not.toHaveBeenCalled();
    expect(service.listenerCount()).toBe(1);
  });

  it('refreshTarget updates a kept entry only (final URL at run release)', () => {
    const registry = new KeptBrowserRegistry(createFakePool().pool);
    const input = baseInput();
    registry.register(input);

    registry.refreshTarget('conversation-a', 'https://example.test/final', 'Final');
    expect(registry.getAlive('conversation-a')).toMatchObject({
      url: 'https://example.test/final',
      title: 'Final',
    });

    input.browserService.emit('close');
    registry.refreshTarget('conversation-a', 'https://example.test/ignored', 'Ignored');
    expect(registry.snapshot('conversation-a')).toMatchObject({
      url: 'https://example.test/final',
    });
  });

  it('markClosed on a stale entry (window dead without close event) frees the pool slot', () => {
    const { pool, released } = createFakePool();
    const registry = new KeptBrowserRegistry(pool);
    registry.register(baseInput());

    registry.markClosed('conversation-a');

    expect(registry.getAlive('conversation-a')).toBeNull();
    expect(registry.snapshot('conversation-a').state).toBe('closed');
    expect(released).toEqual(['surface-key-1']);
    registry.markClosed('conversation-a');
    expect(released).toEqual(['surface-key-1']);
  });

  it('kept windows from different conversations coexist', () => {
    const registry = new KeptBrowserRegistry(createFakePool().pool);
    registry.register(baseInput({ conversationId: 'conversation-a', serviceKey: 'surface-key-a' }));
    registry.register(baseInput({ conversationId: 'conversation-b', serviceKey: 'surface-key-b' }));

    expect(registry.getAlive('conversation-a')?.serviceKey).toBe('surface-key-a');
    expect(registry.getAlive('conversation-b')?.serviceKey).toBe('surface-key-b');
  });
});
