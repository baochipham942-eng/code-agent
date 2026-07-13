// ============================================================================
// executeSpawnAgent 拓扑标注源码契约（2026-07-13 拓扑激活批 2）
//
// 同 spawnAgent.depthGuard.test.ts 采用源码契约测试——executeSpawnAgent 需要完整
// modelConfig/resolver/contextBuilder 链，runtime mock 成本远超本接线复杂度。
//
// 不变量：
//   1. 后台分支（waitForCompletion=false）把 executionTopology 标为 async_agent
//      （尊重调用方已有显式标注）。
//   2. 前台分支（waitForCompletion=true）传 bare executorContext，不注入拓扑
//      ——前台子 agent 缺省 main，行为与激活前一致。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPAWN_AGENT_PATH = path.resolve(
  __dirname,
  '../../../src/host/agent/multiagentTools/spawnAgent.ts',
);

describe('executeSpawnAgent 拓扑标注接线', () => {
  const source = readFileSync(SPAWN_AGENT_PATH, 'utf8');

  it('后台分支注入 executionTopology=async_agent（尊重显式标注）', () => {
    expect(source).toMatch(
      /Start agent in background[\s\S]{0,600}executionTopology:\s*executorContext\.executionTopology\s*\?\?\s*'async_agent'/,
    );
  });

  it('前台分支不注入拓扑（bare executorContext）', () => {
    expect(source).toMatch(
      /if \(waitForCompletion\) \{[\s\S]{0,300}context: executorContext,/,
    );
  });
});
