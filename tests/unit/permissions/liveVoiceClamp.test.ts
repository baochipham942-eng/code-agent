// ============================================================================
// D4 Live 语音抬严 —— 两条权限链各一道门
// ============================================================================
//
// 本仓权限是两条独立的链，抬严必须两条都钉，缺一条就是 #637 同款半边失效：
//   主 agent 链：getModeForSession → resolveSessionPermissionMode → 判定链读它
//   子 agent 链：resolveSubagentPreset → getPresetConfig → checkToolExecution
//
// 两道门都钉「真跑那刻消费者读到的值/行为」，不是钳制函数的映射表：
//   主链断言的是 toolPermissionClassification 真正调用的 resolveSessionPermissionMode
//   子链断言的是 subagentPipeline.checkToolExecution 真正返回的 allowed
// 摘掉任一条 clamp，对应的门必红（变异验证见交付报告）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampLiveVoicePermissionMode,
  clampLiveVoicePermissionPreset,
  getPermissionModeManager,
  permissionModeAutoApproves,
  type PermissionMode,
} from '../../../src/host/permissions/modes';
import {
  readOnlyForcesConfirmationFor,
  resolveSessionPermissionMode,
  resolveToolPermissionClassification,
} from '../../../src/host/tools/toolPermissionClassification';
import { getPresetConfig } from '../../../src/host/services/core/permissionPresets';
import { getSubagentPipeline, resetSubagentPipeline } from '../../../src/host/agent/subagentPipeline';
import type { DynamicAgentConfig } from '../../../src/host/agent/agentDefinition';
import type { PermissionPreset } from '../../../src/shared/contract/permission';

const consumeFirstRunStrictMock = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../../../src/host/services/roleAssets/rolePackInstallService', () => ({
  consumeFirstRunStrict: consumeFirstRunStrictMock,
}));

const { resolveSubagentPreset } = await import('../../../src/host/agent/subagentFirstRunPreset');

describe('D4 主 agent 链：通话态档位抬严', () => {
  const manager = getPermissionModeManager();
  let sessionId: string;

  beforeEach(() => {
    sessionId = `live-voice-${Math.random().toString(36).slice(2)}`;
  });

  const WRITE_TOOL = { requiresPermission: true, permissionLevel: 'write' as const };
  const workingDirectory = '/tmp/live-voice-workspace';

  /**
   * 真跑一次判定链，返回最终审批结果。
   *
   * 这条门必须走到 classification 这一层：只断言「档位变了」会漏掉 2026-07-26 真机
   * 抓到的那个洞——档位钳到 default 之后，classifier 的 W1「写入项目目录内 → approve」
   * 依然放行，写文件照样直接落盘。判据只能是「用户到底会不会被问」。
   */
  async function writeInsideWorkspaceDecision(): Promise<string> {
    const mode = resolveSessionPermissionMode(undefined, sessionId);
    const result = await resolveToolPermissionClassification({
      executionToolName: 'write_file',
      policyToolName: 'write_file',
      params: { file_path: `${workingDirectory}/note.txt`, content: 'hello' },
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory,
      workspaceRoot: workingDirectory,
      permissionLevel: 'write',
      permStartTime: 0,
      readOnlyForcesConfirmation: readOnlyForcesConfirmationFor(mode, WRITE_TOOL),
      sessionPermissionMode: mode,
    });
    return result.decision;
  }

  // 免确认的档就是「用户看不到审批弹窗」的来源。通话时用户手不在键盘上，必须摁掉。
  it.each<[PermissionMode]>([
    ['bypassPermissions'],
    ['acceptEdits'],
    ['default'],
  ])('会话档是 %s 时，通话态下工作区内写入也必须弹确认', async (mode) => {
    manager.setSessionMode(sessionId, mode, true);
    // 前提：不在通话态时这一档确实放行（否则这条测试等于什么都没测）
    await expect(writeInsideWorkspaceDecision()).resolves.toBe('approve');

    manager.markLiveVoiceSession(sessionId);

    await expect(writeInsideWorkspaceDecision()).resolves.toBe('ask');
    const effective = resolveSessionPermissionMode(undefined, sessionId);
    expect(permissionModeAutoApproves(effective, 'write')).toBe(false);
    expect(permissionModeAutoApproves(effective, 'execute')).toBe(false);
  });

  it('挂断后回到会话自己的档位（不能永久钳着）', () => {
    manager.setSessionMode(sessionId, 'acceptEdits', true);
    manager.markLiveVoiceSession(sessionId);
    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe('readOnly');

    manager.clearLiveVoiceSession(sessionId);

    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe('acceptEdits');
  });

  it('没在通话的会话不受影响（不误伤所有人）', () => {
    manager.setSessionMode(sessionId, 'acceptEdits', true);
    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe('acceptEdits');
  });

  it('钳制只收紧不放宽：已经更严的档原样返回', () => {
    expect(clampLiveVoicePermissionMode('dontAsk')).toBe('dontAsk');
    expect(clampLiveVoicePermissionMode('readOnly')).toBe('readOnly');
    expect(clampLiveVoicePermissionMode('plan')).toBe('plan');
    // default 不是「已经够严」——它下面 classifier 仍会放行工作区内写入，所以也要收
    expect(clampLiveVoicePermissionMode('default')).toBe('readOnly');
  });
});

describe('D4 子 agent 链：通话态 preset 抬严', () => {
  const manager = getPermissionModeManager();
  const workingDirectory = '/tmp/live-voice-wd';
  /** 工作目录之外的写入——ci 档放行、development 档不放行，两档的行为分水岭。 */
  const writeOutsideWorkspace = {
    toolName: 'write_file',
    permissionLevel: 'write' as const,
    path: '/tmp/somewhere-else/notes.txt',
  };
  let sessionId: string;

  beforeEach(() => {
    resetSubagentPipeline();
    consumeFirstRunStrictMock.mockReset();
    consumeFirstRunStrictMock.mockResolvedValue(false);
    sessionId = `live-voice-sub-${Math.random().toString(36).slice(2)}`;
  });

  /** 走真实管线：preset → getPresetConfig → createContext → checkToolExecution。 */
  function writeOutsideAllowedFor(preset: PermissionPreset): boolean {
    const pipeline = getSubagentPipeline();
    const config: DynamicAgentConfig = { name: 'voice-child', systemPrompt: '', tools: [], permissionPreset: preset };
    const context = pipeline.createContext(config, workingDirectory);
    expect(context.permissionConfig).toEqual(getPresetConfig(preset, workingDirectory));
    return pipeline.checkToolExecution(context, writeOutsideWorkspace).allowed;
  }

  it('声明 ci 的子 agent，在通话态里真的写不出工作目录', async () => {
    // 前提：不在通话态时 ci 档确实放行（否则这条测试等于什么都没测）
    expect(await resolveSubagentPreset('ci', 'writer', sessionId)).toBe('ci');
    expect(writeOutsideAllowedFor('ci')).toBe(true);

    manager.markLiveVoiceSession(sessionId);

    const preset = await resolveSubagentPreset('ci', 'writer', sessionId);
    expect(preset).toBe('development');
    expect(writeOutsideAllowedFor(preset)).toBe(false);

    manager.clearLiveVoiceSession(sessionId);
  });

  it('已经不免确认的档在通话态原样返回（不误伤）', async () => {
    manager.markLiveVoiceSession(sessionId);

    expect(await resolveSubagentPreset('development', 'writer', sessionId)).toBe('development');
    expect(await resolveSubagentPreset('strict', 'writer', sessionId)).toBe('strict');
    expect(clampLiveVoicePermissionPreset('custom')).toBe('custom');

    manager.clearLiveVoiceSession(sessionId);
  });

  it('首跑 strict 与通话抬严叠加时取更严的那个', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(true);
    manager.markLiveVoiceSession(sessionId);

    expect(await resolveSubagentPreset('ci', 'writer', sessionId)).toBe('strict');

    manager.clearLiveVoiceSession(sessionId);
  });

  it('没在通话的会话，子 agent 档位不受影响', async () => {
    expect(await resolveSubagentPreset('ci', 'writer', sessionId)).toBe('ci');
  });
});
