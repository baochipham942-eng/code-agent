// ============================================================================
// T3b: 会话指挥台前台 brain 的设计声明 + allowlist 组装
//
// 依据 2026-08-07-T3-工具坍缩排查报告 §7.4-2：SESSION_COMMAND_CENTER_BRAIN_CONTEXT
// 缺一句"这是流程设计，不是权限问题或环境故障"的说明，模型只能对用户编"环境受限"。
// 对称应用 skillBoundaryScope.ts 的 buildStrictToolsetNotice 同款声明。
//
// 桌面（agentAppService.ts）与 web（web/routes/agent.ts）两条判定通路共用同一份
// SESSION_COMMAND_CENTER_BRAIN_CONTEXT 常量（web 直接 import 常量，桌面经
// withSessionCommandCenterBrain 拼进 turnSystemContext），改这一处即两路生效。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  SESSION_COMMAND_CENTER_BRAIN_CONTEXT,
  withSessionCommandCenterBrain,
} from '../../../src/host/app/sessionCommandCenterBrain';
import {
  SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES,
  SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
} from '../../../src/shared/constants/sessionCommandCenter';

describe('SESSION_COMMAND_CENTER_BRAIN_CONTEXT design notice', () => {
  it('tells the model the tool narrowing is by design, not an environment fault', () => {
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('流程设计');
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('不是权限问题或环境故障');
    // 反面案例是模型说"环境禁用了/环境受限"（排查报告 §2）——声明必须正面堵住这句话
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('不要向用户说');
  });

  it('names the 5-tool boundary so the model knows what it lacks up front', () => {
    for (const name of SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES) {
      // spawn_task 等工具名本身已在派活纪律段落出现；额外校验声明段落引用了「5 个工具」这一事实
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain(name);
    }
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('5 个工具');
  });
});

describe('withSessionCommandCenterBrain', () => {
  it('sets the 5-tool allowlist and appends the brain context (which carries the design notice)', () => {
    const options = withSessionCommandCenterBrain(undefined);

    expect(options.allowedToolNames).toEqual([...SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES]);
    expect(options.maxIterations).toBe(SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS);
    expect(options.turnSystemContext).toContain(SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
  });

  it('preserves any existing turnSystemContext instead of replacing it', () => {
    const options = withSessionCommandCenterBrain({
      turnSystemContext: ['<existing_context>keep me</existing_context>'],
    });

    expect(options.turnSystemContext).toEqual([
      '<existing_context>keep me</existing_context>',
      SESSION_COMMAND_CENTER_BRAIN_CONTEXT,
    ]);
  });
});
