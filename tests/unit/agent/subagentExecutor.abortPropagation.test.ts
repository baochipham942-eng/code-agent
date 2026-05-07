// ============================================================================
// SubagentExecutor abort signal propagation — D.1 invariant
// ============================================================================
//
// 不变量：subagentExecutor 内每个 modelRouter.inference 调用必须把 effectiveSignal
// 作为第 5 个参数传入。否则父 abort 时，正在跑的 LLM call 不会中途打断，得等
// 当前 inference 自然完成才被循环开头 check 拦下，期间继续烧 token。
//
// 用源码契约测试而不是 runtime mock — 修复本身只是补 1 个参数，setup 一个
// 完整的 SubagentExecutor mock 链 (pipeline / hooks / telemetry / agentTask) 远
// 超修复本身的复杂度，得不偿失。源码扫描足以防回归。
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

describe('subagentExecutor abort signal propagation (D.1)', () => {
  it('every modelRouter.inference call must pass effectiveSignal as 5th arg', () => {
    const source = readFileSync(SUBAGENT_EXECUTOR_PATH, 'utf8');

    // 抓 `this.modelRouter.inference(...)`  和 `modelRouter.inference(...)` 调用
    // 跨多行，括号匹配到 `);`
    const callPattern = /(this\.)?modelRouter\.inference\(([\s\S]*?)\);/g;
    const matches = Array.from(source.matchAll(callPattern));

    expect(matches.length, 'expected at least one modelRouter.inference call in subagentExecutor.ts').toBeGreaterThan(0);

    for (const [fullMatch, , args] of matches) {
      expect(
        args,
        `modelRouter.inference call missing effectiveSignal:\n${fullMatch}`,
      ).toMatch(/\beffectiveSignal\b/);
    }
  });
});
