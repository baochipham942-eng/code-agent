// ============================================================================
// N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE · 验收①：subagentToolRuntime 派生链行为测试
// ============================================================================
// subagentToolRuntime.ts:34 自建 ToolExecutor（不走 forRun），父执行器的写边界开关
// 必须显式继承（context.restrictWritesToWorkspace），否则父开了边界、子代理越界写
// 照样过（#1686 第四轮 ai-review 的绕过路径）。判据锚真实落盘。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { createSubagentToolRuntime } from '../../../src/host/agent/subagentToolRuntime';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

describe('subagentToolRuntime 写边界继承', () => {
  let parent: string;
  let sandbox: string;
  let outside: string;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wsb-sub-')));
    sandbox = path.join(parent, 'a-sandbox');
    outside = path.join(parent, 'z-outside');
    await fs.mkdir(sandbox);
    await fs.mkdir(outside);
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
  });

  afterEach(async () => {
    resetPermissionModeManager();
    await fs.rm(parent, { recursive: true, force: true });
  });

  function buildSubagentExecutor(restrict: boolean) {
    // 与真实 spawn 链同构：父 executor 带 scope，ToolContext.workspaceScope 下传到
    // SubagentExecutionContext，runtime 自建 runContext + executor。
    const workspaceScope = createWorkspaceScope('wsb-sub-project', [{
      sourceId: 'eval-sandbox', path: sandbox, access: 'read_write', role: 'primary',
    }]);
    const context = {
      runId: 'wsb-sub-run',
      sessionId: 'wsb-sub-session',
      workspace: sandbox,
      workspaceScope,
      ...(restrict ? { restrictWritesToWorkspace: true } : {}),
      cwd: sandbox,
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => true },
      events: { emit: () => { /* no-op */ } },
      abortSignal: new AbortController().signal,
    } as unknown as SubagentExecutionContext;
    const runtime = createSubagentToolRuntime({
      context,
      sessionId: 'wsb-sub-session',
      effectiveMode: 'default',
      identity: { agentId: 'wsb-sub-agent', runId: 'wsb-sub-run', parentToolUseId: 'wsb-parent' },
      allowedToolNames: new Set(['Write']),
      checkToolExecution: () => true,
    });
    runtime.executor.setAuditEnabled(false);
    return runtime.executor;
  }

  it('开关下传（开着）：子代理越界写被拦且不落盘', async () => {
    const target = path.join(outside, 'sub-escape.txt');
    const result = await buildSubagentExecutor(true)
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-sub-session' });
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
    expect(existsSync(target)).toBe(false);
  });

  it('开关下传（开着）：子代理沙箱内写放行且真落盘', async () => {
    const target = path.join(sandbox, 'sub-inside.txt');
    const result = await buildSubagentExecutor(true)
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-sub-session' });
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('开关缺席：子代理越界写不被这道闸拦（继承语义的对照面）', async () => {
    const target = path.join(outside, 'sub-off.txt');
    const result = await buildSubagentExecutor(false)
      .execute('Write', { file_path: target, content: 'wsb' }, { sessionId: 'wsb-sub-session' });
    expect(result.metadata?.code).not.toBe('PROJECT_SOURCE_OUTSIDE_WORKSPACE');
  });
});
