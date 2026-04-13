// ============================================================================
// SwarmServices Registry Tests
// 覆盖 register/get/reset、未注册 fail-fast、覆盖式 register、has 探针
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSwarmServices,
  getSwarmServices,
  resetSwarmServices,
  hasSwarmServices,
  type SwarmServices,
} from '../../../src/main/agent/swarmServices';

function makeStubServices(): SwarmServices {
  return {
    planApproval: { _id: 'planApproval' } as never,
    launchApproval: { _id: 'launchApproval' } as never,
    parallelCoordinator: { _id: 'parallelCoordinator' } as never,
    spawnGuard: {
      cancel: () => true,
    },
    teammateService: { _id: 'teammateService' } as never,
    agentHistory: {
      persistAgentRun: async () => undefined,
      getRecentAgentHistory: async () => [],
    },
  };
}

describe('SwarmServices Registry', () => {
  beforeEach(() => {
    resetSwarmServices();
  });

  describe('lifecycle', () => {
    it('未注册时 hasSwarmServices 返回 false', () => {
      expect(hasSwarmServices()).toBe(false);
    });

    it('register 后 hasSwarmServices 返回 true', () => {
      registerSwarmServices(makeStubServices());
      expect(hasSwarmServices()).toBe(true);
    });

    it('reset 后 has 重新返回 false 且 get 抛错', () => {
      registerSwarmServices(makeStubServices());
      resetSwarmServices();

      expect(hasSwarmServices()).toBe(false);
      expect(() => getSwarmServices()).toThrow(/not registered/i);
    });
  });

  describe('fail-fast', () => {
    it('未注册时 getSwarmServices 立即抛 — 不静默 fallback', () => {
      expect(() => getSwarmServices()).toThrow(
        /SwarmServices not registered.*bootstrap/
      );
    });

    it('错误信息提示在 IPC handler 之前调用 register', () => {
      try {
        getSwarmServices();
      } catch (err) {
        expect(String(err)).toMatch(/IPC handlers run/);
      }
    });
  });

  describe('register / get', () => {
    it('register 后 get 返回同一对象引用', () => {
      const services = makeStubServices();
      registerSwarmServices(services);
      expect(getSwarmServices()).toBe(services);
    });

    it('register 第二次会覆盖第一次', () => {
      const first = makeStubServices();
      const second = makeStubServices();

      registerSwarmServices(first);
      expect(getSwarmServices()).toBe(first);

      registerSwarmServices(second);
      expect(getSwarmServices()).toBe(second);
      expect(getSwarmServices()).not.toBe(first);
    });

    it('get 返回的实例可正常调用方法子集', () => {
      registerSwarmServices(makeStubServices());
      const services = getSwarmServices();
      expect(services.spawnGuard.cancel('any-id')).toBe(true);
    });
  });

  describe('结构类型契约', () => {
    it('SpawnGuardLike 只暴露 cancel 方法', () => {
      // 编译期断言：用最小接口注入，不需要完整 SpawnGuard 类
      const minimalGuard = { cancel: (_id: string) => false };
      const services: SwarmServices = {
        ...makeStubServices(),
        spawnGuard: minimalGuard,
      };
      registerSwarmServices(services);
      expect(getSwarmServices().spawnGuard.cancel('x')).toBe(false);
    });

    it('AgentHistoryPort 接受任何符合签名的实现', async () => {
      const stored: Array<{ sessionId: string }> = [];
      const services: SwarmServices = {
        ...makeStubServices(),
        agentHistory: {
          persistAgentRun: async (sessionId, _run) => {
            stored.push({ sessionId });
          },
          getRecentAgentHistory: async () => [],
        },
      };
      registerSwarmServices(services);

      await getSwarmServices().agentHistory.persistAgentRun(
        's1',
        {} as never
      );
      expect(stored).toEqual([{ sessionId: 's1' }]);
    });
  });
});
