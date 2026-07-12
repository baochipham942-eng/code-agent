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
  '../../../src/host/agent/subagentExecutor.ts',
);
const SUBAGENT_EXECUTOR_TYPES_PATH = path.resolve(
  __dirname,
  '../../../src/host/agent/subagentExecutorTypes.ts',
);
const SUBAGENT_PROTOCOL_CONTEXT_PATH = path.resolve(
  __dirname,
  '../../../src/host/agent/subagentProtocolContext.ts',
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

  it('enforces maxToolCalls before any subagent tool execution', () => {
    const source = readFileSync(SUBAGENT_EXECUTOR_PATH, 'utf8');
    const typesSource = readFileSync(SUBAGENT_EXECUTOR_TYPES_PATH, 'utf8');

    expect(typesSource).toContain('maxToolCalls?: number');
    expect(source).toMatch(/toolCallsAttempted\s*>=\s*maxToolCalls/);
    expect(source).toContain('Tool call blocked by tool policy');
    expect(source).toMatch(/toolCallsAttempted\s*\+=\s*1/);
  });
});

// ============================================================================
// ADR-019 批 1：adaptive 泄漏防御（单一防御点）
//
// 不变量：subagentExecutor.execute() 入口必须把 context.modelConfig 经
// resolveModelDecision(context: 'subagent') 归一化——subagent 永不继承
// 父会话的 adaptive 标志。这是所有 spawn 路径（Task 工具 / spawn_agent /
// parallel coordinator）的共同 choke point，在这里防御一次覆盖全部。
// 同 D.1 采用源码契约测试（完整 runtime mock 链得不偿失）。
// ============================================================================

describe('subagentExecutor adaptive leak defense (ADR-019)', () => {
  it('execute() must normalize modelConfig via resolveModelDecision with subagent context', () => {
    const source = readFileSync(SUBAGENT_PROTOCOL_CONTEXT_PATH, 'utf8');

    // 必须 import 单一决策入口
    expect(source).toMatch(/import\s*\{[^}]*resolveModelDecision[^}]*\}\s*from\s*'\.\.\/model\/modelDecision'/);
    // 必须以 subagent context 调用（剥离 adaptive 的路径）
    expect(source).toMatch(/resolveModelDecision\(\s*\{[\s\S]*?context:\s*'subagent'/);
  });

  it('execute() must reassign context.modelConfig to the normalized config at entry', () => {
    const source = readFileSync(SUBAGENT_EXECUTOR_PATH, 'utf8');
    const protocolContextSource = readFileSync(SUBAGENT_PROTOCOL_CONTEXT_PATH, 'utf8');

    // 入口归一化后必须重新赋值 context，让所有下游 context.modelConfig 引用
    // 自动使用剥离 adaptive 后的配置（最小 diff，不强迫全文件改名）
    expect(source).toMatch(/context\s*=\s*normalizeSubagentModelContext\(context,\s*config\.name\)/);
    expect(protocolContextSource).toMatch(/return\s*\{\s*\.\.\.context,\s*modelConfig:\s*config\s*\}/);

    // 归一化必须发生在 execute() 函数体内、E2E 早退分支之前
    const executeBody = source.slice(source.indexOf('async execute('));
    const normalizeIdx = executeBody.indexOf('normalizeSubagentModelContext');
    const e2eIdx = executeBody.indexOf('shouldUseE2ELocalSubagentExecutor');
    expect(normalizeIdx).toBeGreaterThan(-1);
    expect(e2eIdx).toBeGreaterThan(-1);
    expect(normalizeIdx).toBeLessThan(e2eIdx);
  });
});
