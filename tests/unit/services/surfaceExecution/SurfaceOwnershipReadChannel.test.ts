import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SurfaceTargetRefV1 } from '../../../../src/shared/contract/surfaceExecution';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import {
  selectActiveBrowserSurfaceSessionV1,
  selectSurfaceExecutionRunSessionV1,
  useSurfaceExecutionStore,
} from '../../../../src/renderer/stores/surfaceExecutionStore';

const managedTarget: Extract<SurfaceTargetRefV1, { kind: 'browser' }> = {
  kind: 'browser',
  browserInstanceId: 'browser:managed-profile',
  windowRef: 'window:managed-agent',
  tabRef: 'tab:managed-one',
  origin: 'https://example.test',
  documentRevision: 'document:1',
  title: 'Example',
};

/** SurfaceExecutionCompactBar 的 SPINNING_STATES（模块私有常量，此处按值对齐）。 */
const SPINNING_STATES = ['preparing', 'running', 'stopping'];

function createHarness(runId = 'run-1', conversationId = 'conversation-1') {
  const registry = new RunRegistry();
  registry.start({ runId, sessionId: conversationId, workspace: process.cwd() });
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const identity: SurfaceRuntimeIdentityV1 = { conversationId, runId, agentId: 'agent-a' };
  return { registry, runtime, identity };
}

/** 建一个真的 surface 会话，并给它登记一个真的产出（快照读路径要穿过 outputs 才有意义）。 */
function prepareSessionWithOutput(
  runtime: SurfaceExecutionRuntime,
  identity: SurfaceRuntimeIdentityV1,
  workspace: string,
) {
  const prepared = runtime.prepareBrowserSession({ identity });
  runtime.recordBrowserObservation({
    identity,
    surfaceSessionId: prepared.session.sessionId,
    target: managedTarget,
    providerGeneration: 'managed:generation-1',
  });
  const path = join(workspace, 'report.md');
  writeFileSync(path, '# Surface report\n');
  const output = runtime.outputs.registerLocalOutput({
    subject: prepared.subject,
    conversationId: identity.conversationId,
    path,
    sourceRefs: ['artifact://surface-report'],
  });
  expect(output).not.toBeNull();
  return prepared;
}

describe('Surface ownership read channel (取消后快照仍读得到，写路径仍 fail-closed)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'surface-read-channel-'));
    useSurfaceExecutionStore.setState({
      nativeByConversation: {},
      compatibilityByConversation: {},
      sessionsByScope: {},
    });
    return () => rmSync(workspace, { recursive: true, force: true });
  });

  it('serves the conversation snapshot after the run is cancelled and after it is deregistered', async () => {
    const { registry, runtime, identity } = createHarness();
    const prepared = prepareSessionWithOutput(runtime, identity, workspace);

    await registry.get(identity.runId)?.cancel('user');
    const cancelledSnapshot = runtime.snapshotConversation(identity.conversationId);
    expect(cancelledSnapshot.sessions).toHaveLength(1);
    expect(cancelledSnapshot.sessions[0].outputs.map((output) => output.label)).toEqual(['report.md']);
    // 取消即冻结写权：只读通道开了，writable 仍然按活属主判定。
    expect(cancelledSnapshot.sessions[0].writable).toBe(false);
    expect(cancelledSnapshot.sessions[0].availableControls).toEqual([]);

    await runtime.endRun(identity);
    registry.unregister(identity.runId);
    const afterDeregister = runtime.snapshotConversation(identity.conversationId);
    expect(afterDeregister.sessions).toHaveLength(1);
    expect(afterDeregister.sessions[0].session.state).toBe('completed');
    expect(afterDeregister.sessions[0].outputs.map((output) => output.label)).toEqual(['report.md']);
    expect(prepared.session.sessionId).toBe(afterDeregister.sessions[0].session.sessionId);
  });

  it('keeps every write path fail-closed in exactly the same state', async () => {
    const { registry, runtime, identity } = createHarness();
    const prepared = prepareSessionWithOutput(runtime, identity, workspace);
    await registry.get(identity.runId)?.cancel('user');

    // 快照读得到（上一条已证）；同一时刻写路径必须仍然被属主闸挡死。
    expect(() => runtime.prepareBrowserSession({ identity }))
      .toThrowError(expect.objectContaining({
        surfaceError: expect.objectContaining({ code: 'SURFACE_TARGET_NOT_OWNED' }),
      }));
    expect(() => runtime.recordBrowserObservation({
      identity,
      surfaceSessionId: prepared.session.sessionId,
      target: managedTarget,
      providerGeneration: 'managed:generation-2',
    })).toThrowError(expect.objectContaining({
      surfaceError: expect.objectContaining({ code: 'SURFACE_TARGET_NOT_OWNED' }),
    }));
    expect(() => runtime.sessions.requireOwned(prepared.session.sessionId, prepared.subject))
      .toThrowError(expect.objectContaining({
        surfaceError: expect.objectContaining({ code: 'SURFACE_TARGET_NOT_OWNED' }),
      }));
    await expect(runtime.controlConversation({
      conversationId: identity.conversationId,
      surfaceSessionId: prepared.session.sessionId,
      action: 'stop',
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_POLICY_BLOCKED' } });
  });

  it('still rejects a foreign identity on the read channel', () => {
    const { runtime, identity } = createHarness();
    const prepared = prepareSessionWithOutput(runtime, identity, workspace);

    for (const foreign of [
      { ...prepared.subject, runId: 'run-b' },
      { ...prepared.subject, agentId: 'agent-b' },
    ]) {
      expect(() => runtime.outputs.listOwned(foreign)).toThrow(/another run or agent/);
      expect(() => runtime.outputs.projectRefs(foreign, ['artifact://surface-report']))
        .toThrow(/another run or agent/);
      expect(() => runtime.sessions.requireOwnedForRead(prepared.session.sessionId, foreign))
        .toThrow(/another run or agent/);
    }
    expect(() => runtime.sessions.requireOwnedForRead('surface-does-not-exist', prepared.subject))
      .toThrow(/was not found/);
  });

  it('converges the compact bar, composer status, and chrome dot to terminal after cancel', async () => {
    const { registry, runtime, identity } = createHarness();
    prepareSessionWithOutput(runtime, identity, workspace);

    await registry.get(identity.runId)?.cancel('user');
    await runtime.endRun(identity);
    registry.unregister(identity.runId);

    // 消费侧的真实链路：拉全量快照 → 写进 store → 三个指示器读同一份投影。
    const accepted = useSurfaceExecutionStore.getState().setNativeSnapshot(
      identity.conversationId,
      runtime.snapshotConversation(identity.conversationId),
    );
    expect(accepted).toBe('applied');
    const { sessionsByScope } = useSurfaceExecutionStore.getState();

    const runSession = selectSurfaceExecutionRunSessionV1(sessionsByScope, {
      conversationId: identity.conversationId,
    });
    // 行内紧凑条：state 落在 SPINNING_STATES 之外才会停转。
    expect(runSession?.session.state).toBe('completed');
    expect(SPINNING_STATES).not.toContain(runSession?.session.state);
    // composer「执行中」：同一投影，非终态才显示执行中。
    expect(runSession?.writable).toBe(false);
    // chrome 条绿点：终态会话一律选不出来。
    expect(selectActiveBrowserSurfaceSessionV1(sessionsByScope, identity.conversationId)).toBeNull();
  });
});
