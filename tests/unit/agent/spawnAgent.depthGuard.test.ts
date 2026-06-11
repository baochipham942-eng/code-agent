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
const PROTOCOL_TYPES_PATH = path.resolve(
  __dirname,
  '../../../src/main/protocol/tools.ts',
);
const LEGACY_ADAPTER_PATH = path.resolve(
  __dirname,
  '../../../src/main/tools/modules/_helpers/legacyAdapter.ts',
);
const SHADOW_ADAPTER_PATH = path.resolve(
  __dirname,
  '../../../src/main/tools/dispatch/shadowAdapter.ts',
);
const TASK_PATH = path.resolve(
  __dirname,
  '../../../src/main/tools/modules/multiagent/task.ts',
);

describe('executeSpawnAgent 深度截断接线', () => {
  const source = readFileSync(SPAWN_AGENT_PATH, 'utf8');

  it('ToolContext 暴露 spawnDepth 字段', () => {
    const types = readFileSync(TOOL_TYPES_PATH, 'utf8');
    expect(types).toMatch(/spawnDepth\?:\s*number/);
    expect(types).toMatch(/spawnMaxDepth\?:\s*number/);

    const protocolTypes = readFileSync(PROTOCOL_TYPES_PATH, 'utf8');
    expect(protocolTypes).toMatch(/spawnDepth\?:\s*number/);
    expect(protocolTypes).toMatch(/spawnMaxDepth\?:\s*number/);
    expect(types).toMatch(/spawnParentStartedAt\?:\s*number/);
    expect(types).toMatch(/spawnParentTimeoutMs\?:\s*number/);
    expect(types).toMatch(/parentRemainingBudget\?:\s*number/);

    expect(protocolTypes).toMatch(/spawnParentStartedAt\?:\s*number/);
    expect(protocolTypes).toMatch(/spawnParentTimeoutMs\?:\s*number/);
    expect(protocolTypes).toMatch(/parentRemainingBudget\?:\s*number/);
  });

  it('按 context.spawnDepth + 1 算 childDepth 并调 guard.checkDepth', () => {
    // childDepth = (context.spawnDepth ?? 0) + 1
    expect(source).toMatch(/context\.spawnDepth\s*\?\?\s*0/);
    expect(source).toMatch(/checkDepth\(/);
  });

  it('深度超限返回 depth-limit 失败码', () => {
    const idx = source.indexOf('checkDepth(');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 900);
    expect(block).toMatch(/cancellationReason:\s*['"]depth-limit['"]/);
    expect(block).toMatch(/childDepth/);
    expect(block).toMatch(/maxDepth/);
  });

  it('子 toolContext 注入递增后的 spawnDepth（深度沿链路流转）', () => {
    // executorContext.toolContext = { ...context, agentId, spawnDepth: childDepth }
    expect(source).toMatch(/spawnDepth:\s*childDepth/);
  });

  it('子执行器收到父时间窗与父剩余预算', () => {
    expect(source).toMatch(/parentRemainingBudget:\s*context\.parentRemainingBudget/);
    expect(source).toMatch(/spawnParentStartedAt:\s*context\.spawnParentStartedAt/);
    expect(source).toMatch(/spawnParentTimeoutMs:\s*context\.spawnParentTimeoutMs/);
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

describe('Task 深度截断接线', () => {
  const source = readFileSync(TASK_PATH, 'utf8');

  it('Task 也按 ctx.spawnDepth + 1 检查深度', () => {
    expect(source).toMatch(/ctx\.spawnDepth\s*\?\?\s*0/);
    expect(source).toMatch(/checkDepth\(\s*childDepth/);
  });

  it('Task 深度超限返回 depth-limit，错误包含当前深度和上限', () => {
    const idx = source.indexOf('checkDepth(');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 900);
    expect(block).toMatch(/code:\s*['"]DOMAIN_ERROR['"]/);
    expect(block).toMatch(/cancellationReason:\s*['"]depth-limit['"]/);
    expect(block).toMatch(/childDepth/);
    expect(block).toMatch(/maxDepth/);
  });

  it('Task 子 toolContext 注入递增后的 spawnDepth', () => {
    expect(source).toMatch(/spawnDepth:\s*childDepth/);
  });

  it('Task 子执行器收到父时间窗与父剩余预算', () => {
    expect(source).toMatch(/parentRemainingBudget:\s*ctx\.parentRemainingBudget/);
    expect(source).toMatch(/spawnParentStartedAt:\s*ctx\.spawnParentStartedAt/);
    expect(source).toMatch(/spawnParentTimeoutMs:\s*ctx\.spawnParentTimeoutMs/);
  });
});

describe('protocol/legacy adapter 深度字段桥接', () => {
  it('buildLegacyCtxFromProtocol 把 spawnDepth / spawnMaxDepth 映射回 legacy ctx', () => {
    const source = readFileSync(LEGACY_ADAPTER_PATH, 'utf8');
    expect(source).toMatch(/spawnDepth:\s*ctx\.spawnDepth/);
    expect(source).toMatch(/spawnMaxDepth:\s*ctx\.spawnMaxDepth/);
    expect(source).toMatch(/spawnParentStartedAt:\s*ctx\.spawnParentStartedAt/);
    expect(source).toMatch(/spawnParentTimeoutMs:\s*ctx\.spawnParentTimeoutMs/);
    expect(source).toMatch(/parentRemainingBudget:\s*ctx\.parentRemainingBudget/);
  });

  it('buildProtocolContext 从 legacy ctx 带上 spawnDepth / spawnMaxDepth', () => {
    const source = readFileSync(SHADOW_ADAPTER_PATH, 'utf8');
    expect(source).toMatch(/spawnDepth:\s*legacy\?\.spawnDepth/);
    expect(source).toMatch(/spawnMaxDepth:\s*legacy\?\.spawnMaxDepth/);
  });
});
