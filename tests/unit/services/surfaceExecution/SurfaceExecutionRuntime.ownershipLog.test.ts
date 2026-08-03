import { describe, expect, it, vi } from 'vitest';

// 排查报告 §4 取证探针：ensureBrowserSession 创建入口新增归属断言——
// identity.conversationId 非空、且与该 runId 已登记的发起会话一致，
// 不一致/为空时打结构化 error 日志，不改变既有抛错行为。
// mock 掉统一日志服务，spy 住 error 出口来断言探针是否被触发。
const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
  }),
}));

import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

function createHarness(runId = 'run-1', registeredConversationId = 'conversation-1') {
  const registry = new RunRegistry();
  registry.start({ runId, sessionId: registeredConversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  return { registry, runtime };
}

describe('SurfaceExecutionRuntime surface 会话归属 fail-loud 探针', () => {
  it('conversationId 与该 runId 登记的发起会话一致：不触发探针', () => {
    errorSpy.mockClear();
    const { runtime } = createHarness('run-1', 'conversation-1');
    const identity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-a',
    };

    runtime.prepareBrowserSession({ identity });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('conversationId 与该 runId 登记的发起会话不一致：打结构化 error 日志（带两个 ID），行为不变（照常抛错）', () => {
    errorSpy.mockClear();
    const { runtime } = createHarness('run-1', 'conversation-1');
    const mismatchedIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: 'conversation-WRONG',
      runId: 'run-1',
      agentId: 'agent-a',
    };

    expect(() => runtime.prepareBrowserSession({ identity: mismatchedIdentity })).toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0];
    expect(message).toContain('归属');
    expect(meta).toMatchObject({
      claimedConversationId: 'conversation-WRONG',
      registeredConversationId: 'conversation-1',
      runId: 'run-1',
    });
    expect(typeof meta.stack).toBe('string');
  });

  it('conversationId 为空：打结构化 error 日志，行为不变（照常抛错）', () => {
    errorSpy.mockClear();
    const { runtime } = createHarness('run-1', 'conversation-1');
    const emptyIdentity: SurfaceRuntimeIdentityV1 = {
      conversationId: '',
      runId: 'run-1',
      agentId: 'agent-a',
    };

    expect(() => runtime.prepareBrowserSession({ identity: emptyIdentity })).toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0];
    expect(message).toContain('conversationId 为空');
    expect(meta).toMatchObject({ runId: 'run-1', agentId: 'agent-a' });
    expect(typeof meta.stack).toBe('string');
  });
});
