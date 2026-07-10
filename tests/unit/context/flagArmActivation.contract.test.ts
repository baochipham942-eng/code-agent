// ============================================================================
// A3 功能开关「臂激活断言」契约 — L0 activeToolResultPrune / L4 contextCollapse
// ============================================================================
// maka #623 教训泛化：「开关开了 ≠ 链路真触发」（retrieval 臂结构性空跑，
// 评测结论被污染）。每个高价值开关钉死三层契约：
//   1. 开关真开着（production 常量 tripwire——被静默翻掉必须有测试红）
//   2. producer + consumer 同时存在（生产接线源码特征断言：producer 把开关
//      递进管线、consumer 真消费——只有一半就是空跑臂）
//   3. 跑最小 case，断言 trace 记号真出现（layersTriggered + commit log），
//      并有关臂对照组（开关关 ⇒ 记号必须消失，防断言本身空跑）
// 每条断言都做过 mutation 自证（关臂/摘调用方必红），证据见 commit message。
// ============================================================================

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompressionPipeline, type PipelineConfig } from '../../../src/host/context/compressionPipeline';
import { CompressionState } from '../../../src/host/context/compressionState';
import { ACTIVE_PRUNE_PLACEHOLDER_MARKER } from '../../../src/host/context/layers/activeToolResultPrune';
import { ACTIVE_TOOL_RESULT_PRUNE } from '../../../src/shared/constants/agent';
import type { ProjectableMessage } from '../../../src/host/context/projectionEngine';
import type { ToolResultArchiveRef } from '../../../src/host/utils/toolResultSpill';

// L0 归档要落盘：spill 写到 getUserConfigDir() 下，mock 到临时目录（与
// activeToolResultPrune.test.ts 同款模式）
const spillTestRoot = path.join(os.tmpdir(), `neo-arm-activation-spill-${process.pid}`);

vi.mock('../../../src/host/config/configPaths', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  return {
    getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-arm-activation-spill-${process.pid}`),
  };
});

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function makeMsg(id: string, role: string, content: string, turnIndex = 0): ProjectableMessage {
  return { id, role, content, turnIndex };
}

function makeText(targetTokens: number): string {
  return 'word '.repeat(targetTokens);
}

const QUIET_CONFIG: PipelineConfig = {
  // 大窗口：只让被测层达到触发条件，其他阈值层保持安静
  maxTokens: 1_000_000,
  currentTurnIndex: 5,
  isMainThread: true,
  cacheHot: false,
  idleMinutes: 0,
  enableSnip: false,
  enableMicrocompact: false,
  enableContextCollapse: false,
  toolResultBudget: 2000,
};

afterAll(() => {
  fs.rmSync(spillTestRoot, { recursive: true, force: true });
});

describe('L0 activeToolResultPrune 臂激活契约', () => {
  let pipeline: CompressionPipeline;
  let state: CompressionState;

  beforeEach(() => {
    pipeline = new CompressionPipeline();
    state = new CompressionState();
  });

  /** L0 语义：只收归最后一条 assistant 之前的工具结果，故尾部要跟一条 assistant */
  function l0Transcript(): ProjectableMessage[] {
    return [
      makeMsg('u1', 'user', 'run the tool', 0),
      makeMsg('a1', 'assistant', 'running', 0),
      { ...makeMsg('t1', 'tool', makeText(ACTIVE_TOOL_RESULT_PRUNE.MAX_TOKENS_PER_RESULT * 2), 0), toolCallId: 'call-1' },
      makeMsg('a2', 'assistant', 'got the result', 1),
    ];
  }

  it('契约1：production 开关是开着的（被静默翻掉 = 本测试红，逼显式改契约）', () => {
    expect(ACTIVE_TOOL_RESULT_PRUNE.ENABLED).toBe(true);
    expect(ACTIVE_TOOL_RESULT_PRUNE.MAX_TOKENS_PER_RESULT).toBeGreaterThan(0);
  });

  it('契约2：producer（messageBuild 递开关进管线）与 consumer（pipeline 消费）同时存在', () => {
    const producerSrc = readFileSync(
      resolve(repoRoot, 'src/host/agent/runtime/contextAssembly/messageBuild.ts'), 'utf8');
    // producer：生产聊天路径把开关常量递进 pipeline config
    expect(producerSrc).toMatch(/activeToolResultPrune:\s*\{/);
    expect(producerSrc).toMatch(/enabled:\s*armEnabled\s*&&\s*ACTIVE_TOOL_RESULT_PRUNE\.ENABLED/);
    expect(producerSrc).toMatch(/maxTokensPerResult:\s*ACTIVE_TOOL_RESULT_PRUNE\.MAX_TOKENS_PER_RESULT/);
    // consumer：pipeline 真消费该开关并调用层实现 + 留触发记号
    const consumerSrc = readFileSync(resolve(repoRoot, 'src/host/context/compressionPipeline.ts'), 'utf8');
    expect(consumerSrc).toMatch(/config\.activeToolResultPrune\?\.enabled/);
    expect(consumerSrc).toMatch(/applyActiveToolResultPrune\(/);
    expect(consumerSrc).toMatch(/layersTriggered\.push\('active-prune'\)/);
  });

  it('契约3：开关开（production 常量）⇒ 最小 case 真触发，trace 记号 + 占位符 + 归档文件都在', async () => {
    const transcript = l0Transcript();
    const result = await pipeline.evaluate(transcript, state, {
      ...QUIET_CONFIG,
      activeToolResultPrune: {
        enabled: ACTIVE_TOOL_RESULT_PRUNE.ENABLED,
        maxTokensPerResult: ACTIVE_TOOL_RESULT_PRUNE.MAX_TOKENS_PER_RESULT,
        spillSessionId: 'arm-activation-l0',
      },
    });

    // 触发记号 1：管线层报告
    expect(result.layersTriggered).toContain('active-prune');
    // 触发记号 2：消息内容真被换成占位符
    expect(transcript[2].content.startsWith(ACTIVE_PRUNE_PLACEHOLDER_MARKER)).toBe(true);
    // 触发记号 3：compression state commit log 有 active-prune 提交
    const commits = state.getCommitLog().filter((c) => c.layer === 'active-prune');
    expect(commits).toHaveLength(1);
    // 触发记号 4：归档文件真实落盘（占位符指向的取回路径必须可用）
    const archiveRef = commits[0].metadata?.archiveRef as ToolResultArchiveRef | undefined;
    expect(archiveRef?.filePath).toBeTruthy();
    expect(fs.existsSync(archiveRef!.filePath)).toBe(true);
  });

  it('对照组：开关关 ⇒ 全部记号消失（防断言本身空跑）', async () => {
    const transcript = l0Transcript();
    const result = await pipeline.evaluate(transcript, state, {
      ...QUIET_CONFIG,
      activeToolResultPrune: {
        enabled: false,
        maxTokensPerResult: ACTIVE_TOOL_RESULT_PRUNE.MAX_TOKENS_PER_RESULT,
        spillSessionId: 'arm-activation-l0-off',
      },
    });

    expect(result.layersTriggered).not.toContain('active-prune');
    expect(transcript[2].content.startsWith(ACTIVE_PRUNE_PLACEHOLDER_MARKER)).toBe(false);
    expect(state.getCommitLog().filter((c) => c.layer === 'active-prune')).toHaveLength(0);
  });
});

describe('L4 contextCollapse 臂激活契约', () => {
  let pipeline: CompressionPipeline;
  let state: CompressionState;

  beforeEach(() => {
    pipeline = new CompressionPipeline();
    state = new CompressionState();
  });

  /** ≥3 条连续 tool 消息（span 成立）+ 足够 token（savings > 3× summary cost） */
  function l4Transcript(): ProjectableMessage[] {
    const toolMsgs = Array.from({ length: 5 }, (_, i) =>
      makeMsg(`t${i}`, 'tool', makeText(600), i));
    return [...toolMsgs, makeMsg('u-recent', 'user', 'hello', 19)];
  }

  it('契约2：producer（messageBuild 注入 summarize + 开关）与 consumer（pipeline 消费）同时存在', () => {
    const producerSrc = readFileSync(
      resolve(repoRoot, 'src/host/agent/runtime/contextAssembly/messageBuild.ts'), 'utf8');
    // producer：未设置实验 override 时默认开着 L4，且注入了 summarize fn（没有
    // summarize 的 enableContextCollapse=true 是半空跑臂，只会走 skipped-no-summarizer）
    expect(producerSrc).toMatch(/const armEnabled\s*=\s*getCompressionPipelineOverride\(\)\s*\?\?\s*true/);
    expect(producerSrc).toMatch(/enableContextCollapse:\s*armEnabled/);
    expect(producerSrc).toMatch(/summarize:\s*\(messages\)\s*=>/);
    const consumerSrc = readFileSync(resolve(repoRoot, 'src/host/context/compressionPipeline.ts'), 'utf8');
    expect(consumerSrc).toMatch(/config\.enableContextCollapse/);
    expect(consumerSrc).toMatch(/applyContextCollapse\(/);
    expect(consumerSrc).toMatch(/layersTriggered\.push\('contextCollapse'\)/);
  });

  it('契约3：开关开 + 阈值到 ⇒ summarize 真被调用，trace 记号 + commit 都在', async () => {
    const summarize = vi.fn().mockResolvedValue('span summary: tools ran fine');
    const transcript = l4Transcript();

    const result = await pipeline.evaluate(transcript, state, {
      ...QUIET_CONFIG,
      maxTokens: 2000, // 5×600 tokens ≈ 150% 占用 ≥ 75% 阈值
      enableContextCollapse: true,
      summarize,
    });

    // 触发记号 1：summarize 真的被调用（此前套件里只有 expect(summarize).toBeDefined() 的空跑断言）
    expect(summarize).toHaveBeenCalled();
    // 触发记号 2：管线层报告
    expect(result.layersTriggered).toContain('contextCollapse');
    // 触发记号 3：commit log 有 contextCollapse 提交且带 summary
    const commits = state.getCommitLog().filter((c) => c.layer === 'contextCollapse');
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].metadata?.summary).toBe('span summary: tools ran fine');
  });

  it('对照组：开关关 ⇒ summarize 不被调用、记号消失（防断言本身空跑）', async () => {
    const summarize = vi.fn().mockResolvedValue('should never be called');
    const transcript = l4Transcript();

    const result = await pipeline.evaluate(transcript, state, {
      ...QUIET_CONFIG,
      maxTokens: 2000,
      enableContextCollapse: false,
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.layersTriggered).not.toContain('contextCollapse');
    expect(state.getCommitLog().filter((c) => c.layer === 'contextCollapse')).toHaveLength(0);
  });
});
