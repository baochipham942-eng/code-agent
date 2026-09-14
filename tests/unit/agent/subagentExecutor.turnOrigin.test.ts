// ============================================================================
// ADR-067 刀 2：turnOrigin 从 drain 点到 ToolExecutor options 的 plumbing 契约
// ----------------------------------------------------------------------------
// 反向变异锚点：去掉 subagentExecutor 工具执行 options 里的
// `turnOrigin: currentTurnOrigin`（executor 侧拿不到 origin，peer 起源静默放行），
// 本测试必须真红。与 subagentExecutor.abortPropagation.test.ts 同款源码契约测试
// ——完整 SubagentExecutor mock 链远超 plumbing 本身的复杂度。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUBAGENT_EXECUTOR_PATH = path.resolve(__dirname, '../../../src/host/agent/subagentExecutor.ts');
const TOOL_ENGINE_PATH = path.resolve(__dirname, '../../../src/host/agent/runtime/toolExecutionEngine.ts');

describe('subagentExecutor turnOrigin plumbing（ADR-067 D3）', () => {
  const source = readFileSync(SUBAGENT_EXECUTOR_PATH, 'utf8');

  it('drain 注入点用 collectTurnOrigins 刷新本轮 origin 链（无注入轮保留上一条）', () => {
    expect(source).toContain('currentTurnOrigin = collectTurnOrigins(pendingMessages) ?? currentTurnOrigin');
  });

  it('工具执行 options 必须带 turnOrigin: currentTurnOrigin（去掉 = peer 起源静默放行）', () => {
    expect(source).toContain('turnOrigin: currentTurnOrigin');
  });
});

describe('toolExecutionEngine 主循环 user 起源铸造（ADR-067 D3）', () => {
  const source = readFileSync(TOOL_ENGINE_PATH, 'utf8');

  it('主代理常规输入经 mintUserTurnOrigin 铸 user 起源进 options', () => {
    expect(source).toMatch(/turnOrigin:\s*mintUserTurnOrigin\(\{/);
  });
});
