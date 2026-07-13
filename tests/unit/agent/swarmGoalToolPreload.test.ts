// ============================================================================
// Swarm Goal（P4）工具预加载门控 — 对真实 getDeferredToolsToPreloadForTurn 的集成断言
// AC1：goal mode + allowSwarm → 预加载 workflow；AC5：allowSwarm=false → 不预加载
// （确定性，零模型成本；走真实门控函数而非 mock）
// ============================================================================

import { describe, it, expect } from 'vitest';
import { getDeferredToolsToPreloadForTurn } from '../../../src/host/agent/runtime/contextAssembly/deferredToolPreload';
import { buildGoalContract, GoalModeController } from '../../../src/host/agent/goalModeController';
import type { Message } from '../../../src/shared/contract';
import { TurnState } from '../../../src/host/agent/runtime/turnState';

function runtime(opts: { goalMode?: GoalModeController; userText?: string }) {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: opts.userText ?? '把测试修绿', timestamp: 0 } as Message,
  ];
  return {
    enableToolDeferredLoading: true,
    executionIntent: undefined,
    messages,
    goalMode: opts.goalMode,
    turn: TurnState.forTest(),
  };
}

function goal(allowSwarm: boolean): GoalModeController {
  return new GoalModeController(
    buildGoalContract({ goal: '把测试修绿', verifyCommand: 'npm test', allowSwarm }),
  );
}

describe('AC1/AC5：swarm goal 工具预加载门控', () => {
  it('AC1：goal mode + allowSwarm=true → 预加载 workflow（同时仍预加载 attempt_completion）', () => {
    const tools = getDeferredToolsToPreloadForTurn(runtime({ goalMode: goal(true) }));
    expect(tools).toContain('attempt_completion');
    expect(tools).toContain('workflow');
  });

  it('AC5：goal mode + allowSwarm=false → 不预加载 workflow（仍预加载 attempt_completion）', () => {
    const tools = getDeferredToolsToPreloadForTurn(runtime({ goalMode: goal(false) }));
    expect(tools).toContain('attempt_completion');
    expect(tools).not.toContain('workflow');
  });

  it('非 goal mode → 既不预加载 attempt_completion 也不（因 goal）预加载 workflow', () => {
    const tools = getDeferredToolsToPreloadForTurn(runtime({ goalMode: undefined, userText: '帮我看下这个文件' }));
    expect(tools).not.toContain('attempt_completion');
    expect(tools).not.toContain('workflow');
  });
});
