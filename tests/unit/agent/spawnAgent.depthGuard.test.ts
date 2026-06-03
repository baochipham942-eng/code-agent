// ============================================================================
// executeSpawnAgent 深度截断 + 结构化失败码 producer（swarm 护栏 P1-2 #2）
// ============================================================================
//
// 不变量：
//   1. spawn 时按 (context.spawnDepth ?? 0) + 1 算 childDepth，调 guard.checkDepth；
//      超限返回 depth-limit 失败码（确定性，主 loop 不该重试）。
//   2. 子 toolContext 注入递增后的 spawnDepth，让深度沿 spawn 链路流转。
//   3. readonly 父 role 拒启 writer 子 → child-refusal 失败码。
//   4. 两个 spawn 时失败码都带上 routeFailureCode 算出的 failureRouting（让消费策略
//      随结果上抛，而非编排层 parse error 字符串）。
//
// 同 abortPropagation / failureCodes 采用源码契约测试——executeSpawnAgent 需要完整
// modelConfig/resolver/contextBuilder 链，runtime mock 成本远超本接线复杂度。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPAWN_AGENT_PATH = path.resolve(
  __dirname,
  '../../../src/main/agent/multiagentTools/spawnAgent.ts',
);
const TOOL_TYPES_PATH = path.resolve(
  __dirname,
  '../../../src/main/tools/types.ts',
);

describe('executeSpawnAgent 深度截断接线', () => {
  const source = readFileSync(SPAWN_AGENT_PATH, 'utf8');

  it('ToolContext 暴露 spawnDepth 字段', () => {
    const types = readFileSync(TOOL_TYPES_PATH, 'utf8');
    expect(types).toMatch(/spawnDepth\?:\s*number/);
  });

  it('按 context.spawnDepth + 1 算 childDepth 并调 guard.checkDepth', () => {
    // childDepth = (context.spawnDepth ?? 0) + 1
    expect(source).toMatch(/context\.spawnDepth\s*\?\?\s*0/);
    expect(source).toMatch(/checkDepth\(/);
  });

  it('深度超限返回 depth-limit 失败码', () => {
    const idx = source.indexOf('checkDepth(');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 600);
    expect(block).toMatch(/cancellationReason:\s*['"]depth-limit['"]/);
  });

  it('子 toolContext 注入递增后的 spawnDepth（深度沿链路流转）', () => {
    // executorContext.toolContext = { ...context, agentId, spawnDepth: childDepth }
    expect(source).toMatch(/spawnDepth:\s*childDepth/);
  });

  it('readonly 父拒启 writer 子 → child-refusal 失败码', () => {
    const idx = source.indexOf('readonlyCheck.allowed');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 600);
    expect(block).toMatch(/cancellationReason:\s*['"]child-refusal['"]/);
  });

  it('spawn 时失败码带上 routeFailureCode 算出的消费策略', () => {
    expect(source).toMatch(/routeFailureCode\(/);
  });
});
