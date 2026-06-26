// ============================================================================
// SubagentExecutor 结构化失败码 producer（swarm 护栏 P1-2 #1）
// ============================================================================
//
// 不变量：子代理触顶自身预算（pipeline.checkBudget 失败）时，返回的失败结果
// 必须带 cancellationReason: 'child-max-tokens'，让编排层能按码分治（routeFailureCode
// → 'degrade'）而不是只能 parse 笼统的 error 字符串。
//
// 同 abortPropagation 采用源码契约测试——完整 runtime mock 链（pipeline / hooks /
// telemetry / agentTask / modelRouter）远超本绑定本身的复杂度，源码扫描足以防回归。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUBAGENT_EXECUTOR_PATH = path.resolve(
  __dirname,
  '../../../src/main/agent/subagentExecutor.ts',
);

describe('subagentExecutor 结构化失败码 producer', () => {
  it('初始预算耗尽的失败返回必须带 child-max-tokens 失败码', () => {
    const source = readFileSync(SUBAGENT_EXECUTOR_PATH, 'utf8');

    // 抓初始 budget 检查失败分支：if (!budgetCheck.allowed) { ... return {...} }
    const idx = source.indexOf('if (!budgetCheck.allowed)');
    expect(idx, '应存在初始预算检查失败分支').toBeGreaterThan(-1);

    // 该分支内（到下一个 while 循环前）的 return 必须带 child-max-tokens
    const block = source.slice(idx, idx + 1200);
    expect(
      block,
      '初始预算耗尽返回应携带 cancellationReason: child-max-tokens',
    ).toMatch(/cancellationReason:\s*['"]child-max-tokens['"]/);
    expect(
      block,
      '初始预算耗尽返回应携带统一 AgentFailureCode',
    ).toMatch(/failureCode:\s*AgentFailureCode\.BudgetExhausted/);
  });
});
