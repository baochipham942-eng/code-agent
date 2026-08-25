// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

// 复现 2026-08-25 真机崩法：persist 把 Map 序列化成 `{}`，回灌后 checkMemory 里 `.has` 不是函数。
describe('permissionStore rehydrate', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('permission-memory', JSON.stringify({
      state: { memory: { session: {}, persistent: { 'Bash:ls': 'allow' } } },
      version: 0,
    }));
  });

  it('rebuilds session as a Map and keeps persistent memory after rehydrate', async () => {
    const { usePermissionStore } = await import('../../../src/renderer/stores/permissionStore');
    await usePermissionStore.persist.rehydrate();
    const { memory, checkMemory } = usePermissionStore.getState();
    expect(memory.session).toBeInstanceOf(Map);
    expect(memory.persistent).toEqual({ 'Bash:ls': 'allow' });
    expect(() => checkMemory({ tool: 'Bash', command: 'ls' } as never)).not.toThrow();
  });
});
