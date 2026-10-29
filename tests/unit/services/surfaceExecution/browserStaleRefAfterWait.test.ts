// ============================================================================
// N-BROWSER-WAIT-FOR-USER-RESUME-W1 — 「等待用户期间页面变了 ⇒ 旧元素引用必须被拒」
// 全链钉子（不改产品代码，只加测试）：
//   A（状态护栏）：takeover 使 run/agent/session 的 fresh 观察全部 superseded
//      （SurfaceHumanTakeoverService.request → invalidateSession）；用户改页面后
//      resume，用等待前的 predecessorStateId 发变更动作 → coordinator consume→
//      requireFresh 抛 SURFACE_STATE_STALE，dispatch 0 次。
//   B（引用护栏）：resume 后对改过的页面记录新观察（新 documentRevision、元素表里
//      没有旧 ref）→ 旧 ref 作用于新 stateId → BrowserElementRefFence 抛
//      SURFACE_ELEMENT_REF_NOT_FOUND（或带冲突 revision/backendNodeId 时
//      SURFACE_TARGET_REVISION_CHANGED）；同观察的新 ref 放行（护栏不是无差别拒绝）。
//   C（护栏范围）：只读动作（screenshot，mutation=false）携带旧 ref 不被引用护栏拦
//      ——护栏只作用于变更动作。
// fixture 从 SurfaceBrowserRuntime.test.ts 抄最小集（工单要求，不跨文件 import）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { SurfaceTargetRefV1 } from '../../../../src/shared/contract/surfaceExecution';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
  type SurfaceTakeoverControlV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';

const pageOneTarget: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
  kind: 'browser',
  browserInstanceId: 'browser:managed-profile',
  windowRef: 'window:managed-agent',
  tabRef: 'tab:managed-one',
  origin: 'https://example.test',
  documentRevision: 'document:1',
  title: 'Example',
};

/** 用户在等待期间导航后的同一 tab：documentRevision 前进。 */
const pageTwoTarget: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
  ...pageOneTarget,
  documentRevision: 'document:2',
  title: 'Example (changed)',
};

function createHarness(runId = 'run-1', conversationId = 'conversation-1') {
  const registry = new RunRegistry();
  registry.start({ runId, sessionId: conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = { conversationId, runId, agentId: 'agent-a' };
  return { registry, runtime, identity };
}

function element(ref: string, backendNodeId: number, documentRevision: string) {
  return {
    kind: 'browser-element' as const,
    ref,
    tabRef: pageOneTarget.tabRef,
    documentRevision,
    backendNodeId,
    role: 'button',
    name: ref.replace('element:', ''),
  };
}

type DispatchRecorder = { dispatches: number };

function clickInput(input: {
  identity: SurfaceRuntimeIdentityV1;
  surfaceSessionId: string;
  predecessorStateId: string;
  operationId: string;
  targetRef: Record<string, unknown>;
  recorder: DispatchRecorder;
}) {
  return {
    identity: input.identity,
    surfaceSessionId: input.surfaceSessionId,
    predecessorStateId: input.predecessorStateId,
    operationId: input.operationId,
    action: 'click',
    arguments: { action: 'click', targetRef: input.targetRef },
    async dispatch() {
      input.recorder.dispatches += 1;
      return { providerResult: {}, outcome: { delivery: 'confirmed' as const } };
    },
  };
}

describe('Browser 等待用户期间页面变化后旧元素引用被拒（W1）', () => {
  it('A 状态护栏：takeover/resume 后用等待前的 state 变更 → SURFACE_STATE_STALE，dispatch 0', async () => {
    const { runtime, identity } = createHarness();
    const prepared = runtime.prepareBrowserSession({ identity });
    const observed = runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: pageOneTarget,
      providerGeneration: 'managed:generation-w1-a',
      elements: [element('element:save', 42, pageOneTarget.documentRevision)],
    });
    const recorder: DispatchRecorder = { dispatches: 0 };

    // 用户接管（takeover 内部 invalidateSession 把该 subject 的 fresh 观察全部 superseded）。
    const takeover = await runtime.control(prepared.subject, 'takeover', { reason: 'User takeover', timeoutMs: 5_000 }) as SurfaceTakeoverControlV1;
    expect(runtime.sessions.get(prepared.session.sessionId)?.state).toBe('waiting_human');

    // 用户在等待期间改了页面——刻意「不重新观察」，resume 后直接拿等待前的 state + 旧 ref 变更。
    await runtime.control(prepared.subject, 'resume');
    await expect(takeover.wait).resolves.toBe('continue');

    await expect(runtime.executeBrowserAction(clickInput({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: observed.observation.stateId,
      operationId: 'w1-a-stale-predecessor',
      targetRef: { ref: 'element:save' },
      recorder,
    }))).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_STATE_STALE' } });
    expect(recorder.dispatches).toBe(0);
  });

  it('B 引用护栏：新观察后旧 ref 被拒、新观察的 ref 放行', async () => {
    const { runtime, identity } = createHarness();
    const prepared = runtime.prepareBrowserSession({ identity });
    runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: pageOneTarget,
      providerGeneration: 'managed:generation-w1-b',
      elements: [element('element:save', 42, pageOneTarget.documentRevision)],
    });

    await runtime.control(prepared.subject, 'takeover', { reason: 'User takeover', timeoutMs: 5_000 });
    // 等待期间用户改页面 → resume 后 agent 重新观察（document:2，元素表里没有 element:save，
    // 换成 element:save2 / backendNodeId 77）。
    await runtime.control(prepared.subject, 'resume');
    const reobserved = runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: pageTwoTarget,
      providerGeneration: 'managed:generation-w1-b',
      elements: [element('element:save2', 77, pageTwoTarget.documentRevision)],
    });
    const recorder: DispatchRecorder = { dispatches: 0 };

    // 旧 ref 不在新观察里 → SURFACE_ELEMENT_REF_NOT_FOUND，dispatch 0。
    await expect(runtime.executeBrowserAction(clickInput({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: reobserved.observation.stateId,
      operationId: 'w1-b-old-ref',
      targetRef: { ref: 'element:save' },
      recorder,
    }))).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_ELEMENT_REF_NOT_FOUND' } });
    expect(recorder.dispatches).toBe(0);

    // 带 rev/backendNodeId 的旧式描述撞上新观察 → SURFACE_TARGET_REVISION_CHANGED，dispatch 0。
    await expect(runtime.executeBrowserAction(clickInput({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: reobserved.observation.stateId,
      operationId: 'w1-b-conflicting-revision',
      targetRef: {
        ref: 'element:save2',
        tabRef: pageOneTarget.tabRef,
        documentRevision: pageOneTarget.documentRevision,
        backendNodeId: 42,
      },
      recorder,
    }))).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_REVISION_CHANGED' } });
    expect(recorder.dispatches).toBe(0);

    // 新观察自己的 ref 放行——护栏不是无差别拒绝。
    await expect(runtime.executeBrowserAction(clickInput({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: runtime.recordBrowserObservation({
        identity,
        surfaceSessionId: prepared.session.sessionId,
        target: pageTwoTarget,
        providerGeneration: 'managed:generation-w1-b',
        elements: [element('element:save2', 77, pageTwoTarget.documentRevision)],
      }).observation.stateId,
      operationId: 'w1-b-new-ref',
      targetRef: { ref: 'element:save2' },
      recorder,
    }))).resolves.toBeTruthy();
    expect(recorder.dispatches).toBe(1);
  });

  it('C 护栏范围：只读动作（screenshot）携带旧 ref 不被引用护栏拦截', async () => {
    const { runtime, identity } = createHarness();
    const prepared = runtime.prepareBrowserSession({ identity });
    runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: pageOneTarget,
      providerGeneration: 'managed:generation-w1-c',
      elements: [element('element:save', 42, pageOneTarget.documentRevision)],
    });
    await runtime.control(prepared.subject, 'takeover', { reason: 'User takeover', timeoutMs: 5_000 });
    await runtime.control(prepared.subject, 'resume');
    const reobserved = runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: pageTwoTarget,
      providerGeneration: 'managed:generation-w1-c',
      elements: [element('element:save2', 77, pageTwoTarget.documentRevision)],
    });
    const recorder: DispatchRecorder = { dispatches: 0 };

    // screenshot 是 risk:read（mutation=false）：引用护栏只挂在变更动作上，旧 ref 不拦、
    // 也不做 consume（无 STALE），照常 dispatch。
    await expect(runtime.executeBrowserAction({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      predecessorStateId: reobserved.observation.stateId,
      operationId: 'w1-c-read-old-ref',
      action: 'screenshot',
      arguments: { action: 'screenshot', targetRef: { ref: 'element:save' } },
      async dispatch() {
        recorder.dispatches += 1;
        return { providerResult: {}, outcome: { delivery: 'confirmed' as const } };
      },
    })).resolves.toBeTruthy();
    expect(recorder.dispatches).toBe(1);
  });
});
