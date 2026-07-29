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

describe('D4 主 agent 链：通话态档位跟随会话选择', () => {
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

  // 2026-07-29 拍板：通话态不再抬严，档位跟随用户自己的选择。
  // 判据仍然是「用户到底会不会被问」，不是「档位字段等于什么」——档位不是放行的
  // 唯一闸门（classifier 的 W1 规则与档位无关，2026-07-26 那个洞就是这么漏的）。
  it.each<[PermissionMode]>([
    ['acceptEdits'],
    ['default'],
  ])('会话档是 %s 时，通话态下工作区内写入照旧放行（不再被通话改判）', async (mode) => {
    manager.setSessionMode(sessionId, mode, true);
    await expect(writeInsideWorkspaceDecision()).resolves.toBe('approve');

    manager.markLiveVoiceSession(sessionId, 'call:test');

    // 通话前后同一个判定，一个字都不许变
    await expect(writeInsideWorkspaceDecision()).resolves.toBe('approve');
    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe(mode);
  });

  // 唯一保留的底线。理由不是不信任用户，是 ASR 会听错（2026-07-29 实录：
  // 「a.txt」被听成「a点text」，最后落盘的文件叫 notes.md）——文本模式下打错字
  // 用户自己看得见，语音下看不见。bypass + 听错 = 零确认执行一条他没说过的命令。
  it('唯一底线：bypassPermissions 在通话态降到 acceptEdits（执行不再免确认，写入仍免）', () => {
    manager.setSessionMode(sessionId, 'bypassPermissions', true);
    expect(permissionModeAutoApproves(resolveSessionPermissionMode(undefined, sessionId), 'execute')).toBe(true);

    manager.markLiveVoiceSession(sessionId, 'call:test');

    const effective = resolveSessionPermissionMode(undefined, sessionId);
    expect(effective).toBe('acceptEdits');
    expect(permissionModeAutoApproves(effective, 'execute')).toBe(false);
    expect(permissionModeAutoApproves(effective, 'write')).toBe(true);
  });

  it('用户自己选的 readOnly 通话态原样保留（不放宽）', () => {
    manager.setSessionMode(sessionId, 'readOnly', true);
    manager.markLiveVoiceSession(sessionId, 'call:test');
    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe('readOnly');
  });

  it('挂断后回到会话自己的档位（底线钳制不能永久挂着）', () => {
    manager.setSessionMode(sessionId, 'bypassPermissions', true);
    manager.markLiveVoiceSession(sessionId, 'call:test');
    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe('acceptEdits');

    manager.clearLiveVoiceSession(sessionId, 'call:test');

    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe('bypassPermissions');
  });

  // 票据生命周期本身**不随抬严一起废掉**：通话态标记现在还有第二个消费者——
  // 交互式工具收窄（requiresUserPresence，通话里 AskUserQuestion 一律拿掉）。
  // 那条同样必须罩住「挂断后 run 还在跑」的窗口，否则 run 会在半途突然
  // 拿回一个用户根本点不了的提问工具。所以这三条改成钉**标记**的寿命。
  it('挂断后，语音派的 run 还在飞时通话态标记不解除', () => {
    manager.markLiveVoiceSession(sessionId, 'call:test');        // 建连
    manager.markLiveVoiceSession(sessionId, 'run:voice-work-1'); // 语音派活

    manager.clearLiveVoiceSession(sessionId, 'call:test');       // ← 用户挂断，run 还在跑

    expect(manager.isLiveVoiceSession(sessionId)).toBe(true);
  });

  it('语音派的 run 落地后才解除（最后一张票还掉）', () => {
    manager.markLiveVoiceSession(sessionId, 'call:test');
    manager.markLiveVoiceSession(sessionId, 'run:voice-work-1');
    manager.clearLiveVoiceSession(sessionId, 'call:test');

    manager.clearLiveVoiceSession(sessionId, 'run:voice-work-1');

    expect(manager.isLiveVoiceSession(sessionId)).toBe(false);
  });

  it('多个语音 run 并存时，任一还在飞标记就还在', () => {
    manager.markLiveVoiceSession(sessionId, 'run:a');
    manager.markLiveVoiceSession(sessionId, 'run:b');

    manager.clearLiveVoiceSession(sessionId, 'run:a');
    expect(manager.isLiveVoiceSession(sessionId)).toBe(true);

    manager.clearLiveVoiceSession(sessionId, 'run:b');
    expect(manager.isLiveVoiceSession(sessionId)).toBe(false);
  });

  it('没在通话的会话不受影响（不误伤所有人）', () => {
    manager.setSessionMode(sessionId, 'acceptEdits', true);
    expect(resolveSessionPermissionMode(undefined, sessionId)).toBe('acceptEdits');
  });

  it('除 bypassPermissions 外一律原样返回（跟随用户选择）', () => {
    expect(clampLiveVoicePermissionMode('bypassPermissions')).toBe('acceptEdits');
    expect(clampLiveVoicePermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(clampLiveVoicePermissionMode('default')).toBe('default');
    expect(clampLiveVoicePermissionMode('dontAsk')).toBe('dontAsk');
    expect(clampLiveVoicePermissionMode('readOnly')).toBe('readOnly');
    expect(clampLiveVoicePermissionMode('plan')).toBe('plan');
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

    manager.markLiveVoiceSession(sessionId, 'call:test');

    const preset = await resolveSubagentPreset('ci', 'writer', sessionId);
    expect(preset).toBe('development');
    expect(writeOutsideAllowedFor(preset)).toBe(false);

    manager.clearLiveVoiceSession(sessionId, 'call:test');
  });

  it('已经不免确认的档在通话态原样返回（不误伤）', async () => {
    manager.markLiveVoiceSession(sessionId, 'call:test');

    expect(await resolveSubagentPreset('development', 'writer', sessionId)).toBe('development');
    expect(await resolveSubagentPreset('strict', 'writer', sessionId)).toBe('strict');
    expect(clampLiveVoicePermissionPreset('custom')).toBe('custom');

    manager.clearLiveVoiceSession(sessionId, 'call:test');
  });

  it('首跑 strict 与通话抬严叠加时取更严的那个', async () => {
    consumeFirstRunStrictMock.mockResolvedValue(true);
    manager.markLiveVoiceSession(sessionId, 'call:test');

    expect(await resolveSubagentPreset('ci', 'writer', sessionId)).toBe('strict');

    manager.clearLiveVoiceSession(sessionId, 'call:test');
  });

  it('没在通话的会话，子 agent 档位不受影响', async () => {
    expect(await resolveSubagentPreset('ci', 'writer', sessionId)).toBe('ci');
  });
});
