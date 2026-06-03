// ============================================================================
// SubagentExecutor 孤儿回收父探活（swarm 护栏 P1-2 #5）
// ============================================================================
//
// 不变量：subagentExecutor 主循环每轮按 context.isParentAlive() 探活；父 run 已结束/
// 被新 run 取代（返回 false）时，用 'parent-gone' 中止本子代理，复用现有 abort 路径
// 落盘部分产物。只给后台 detached 子代理注入 isParentAlive（前台被父 await 不会成孤儿）。
//
// 同 abortPropagation / failureCodes 采用源码契约测试——executor runtime mock 链
// 成本远超本接线复杂度，源码扫描足以防回归。
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
const SUBAGENT_TYPES_PATH = path.resolve(
  __dirname,
  '../../../src/main/agent/subagentExecutorTypes.ts',
);
const SPAWN_AGENT_PATH = path.resolve(
  __dirname,
  '../../../src/main/agent/multiagentTools/spawnAgent.ts',
);

describe('SubagentContext 父探活字段', () => {
  it('SubagentContext 暴露 isParentAlive?: () => boolean', () => {
    const types = readFileSync(SUBAGENT_TYPES_PATH, 'utf8');
    expect(types).toMatch(/isParentAlive\?:\s*\(\)\s*=>\s*boolean/);
  });
});

describe('subagentExecutor 主循环探活', () => {
  const source = readFileSync(SUBAGENT_EXECUTOR_PATH, 'utf8');

  it('主循环里调用 context.isParentAlive 探活', () => {
    expect(source).toMatch(/context\.isParentAlive/);
  });

  it('父消失时用 parent-gone 中止（复用 effectiveController.abort）', () => {
    const idx = source.indexOf('isParentAlive');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 400);
    expect(block).toMatch(/effectiveController\.abort\(\s*['"]parent-gone['"]\s*\)/);
  });
});

describe('executeSpawnAgent 只给后台 detached 子注入探活', () => {
  const source = readFileSync(SPAWN_AGENT_PATH, 'utf8');

  it('注入 isParentAlive 到 executor context', () => {
    expect(source).toMatch(/isParentAlive/);
  });

  it('探活依据父 session 状态 + startTime（区分同 session 新 run）', () => {
    expect(source).toMatch(/getSessionState/);
    expect(source).toMatch(/startTime/);
  });

  it('isParentAlive 仅在后台 detached（!waitForCompletion）时构造，前台不装', () => {
    // 真正的不变量是 gating 条件，而非物理位置：构造被 !waitForCompletion 守卫
    expect(source).toMatch(/if\s*\(\s*!waitForCompletion\s*&&\s*context\.sessionId\s*\)/);
  });

  it('用动态 import 取 TaskManager，避开 task→agent 静态循环依赖', () => {
    expect(source).toMatch(/await import\(\s*['"]\.\.\/\.\.\/task\/TaskManager['"]\s*\)/);
  });
});
