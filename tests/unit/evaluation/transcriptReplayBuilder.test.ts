// ============================================================================
// transcriptReplayBuilder — pure helper 单测
// 主流程（buildTranscriptReplay）由 telemetryQueryService.test.ts 间接覆盖
// 本文件验证 pure helpers 行为与原 class 实现 1:1 对齐
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildMemoryAuditBlock,
  createEmptyToolDistribution,
  normalizeToolCategory,
  getToolResultContent,
} from '../../../src/main/evaluation/transcriptReplayBuilder';
import type { ToolResult } from '../../../src/shared/contract';
import type { TurnQualitySummary } from '../../../src/shared/contract/turnQuality';

describe('createEmptyToolDistribution', () => {
  it('返回所有 ReplayToolCategory 的零计数对象', () => {
    const dist = createEmptyToolDistribution();
    expect(dist).toEqual({
      Read: 0, Edit: 0, Write: 0, Bash: 0,
      Search: 0, Web: 0, Agent: 0, Skill: 0, Other: 0,
    });
  });

  it('每次返回独立实例', () => {
    const a = createEmptyToolDistribution();
    const b = createEmptyToolDistribution();
    a.Read = 5;
    expect(b.Read).toBe(0);
  });
});

describe('normalizeToolCategory', () => {
  it.each([
    ['Read', 'Read'],
    ['read_file', 'Read'],
    ['readXlsx', 'Read'],
    ['Edit', 'Edit'],
    ['Write', 'Write'],
    ['create_file', 'Write'],
    ['Bash', 'Bash'],
    ['terminal', 'Bash'],
    ['Glob', 'Search'],
    ['grep', 'Search'],
    ['webFetch', 'Web'],
    ['Agent', 'Agent'],
    ['Skill', 'Skill'],
  ])('TOOL_CATEGORY_MAP %s -> %s', (input, expected) => {
    expect(normalizeToolCategory(input)).toBe(expected);
  });

  it('fallback substring: write OR create -> Write', () => {
    expect(normalizeToolCategory('overwriteSomething')).toBe('Write');
    expect(normalizeToolCategory('createDir')).toBe('Write');
  });

  it('fallback substring: bash OR exec OR terminal -> Bash', () => {
    expect(normalizeToolCategory('bashRunner')).toBe('Bash');
    expect(normalizeToolCategory('execScript')).toBe('Bash');
    expect(normalizeToolCategory('myTerminalThing')).toBe('Bash');
  });

  it('fallback substring: web OR fetch OR url -> Web', () => {
    expect(normalizeToolCategory('fetchPage')).toBe('Web');
    expect(normalizeToolCategory('urlOpen')).toBe('Web');
  });

  it('未知名字落到 Other', () => {
    expect(normalizeToolCategory('Foo')).toBe('Other');
    expect(normalizeToolCategory('xyz')).toBe('Other');
  });

  it('优先级：列表中的精确匹配胜过 fallback', () => {
    // listDirectory 在 map 里映射 Search，含 'list' 但 fallback 也归 Search
    expect(normalizeToolCategory('listDirectory')).toBe('Search');
  });
});

describe('getToolResultContent', () => {
  it('优先返回 output', () => {
    const r: ToolResult = { toolCallId: 'x', success: true, output: 'OUT', error: 'ERR' } as ToolResult;
    expect(getToolResultContent(r)).toBe('OUT');
  });

  it('output 缺失时返回 error', () => {
    const r: ToolResult = { toolCallId: 'x', success: false, error: 'ERR' } as ToolResult;
    expect(getToolResultContent(r)).toBe('ERR');
  });

  it('output/error 都缺失时返回 outputPath', () => {
    const r: ToolResult = { toolCallId: 'x', success: true, outputPath: '/tmp/a' } as ToolResult;
    expect(getToolResultContent(r)).toBe('/tmp/a');
  });

  it('全部缺失时返回 metadata 的 JSON 字符串', () => {
    const r: ToolResult = { toolCallId: 'x', success: true, metadata: { k: 1 } } as ToolResult;
    expect(getToolResultContent(r)).toBe('{"k":1}');
  });

  it('完全空时返回空串', () => {
    const r: ToolResult = { toolCallId: 'x', success: true } as ToolResult;
    expect(getToolResultContent(r)).toBe('');
  });
});

describe('buildMemoryAuditBlock', () => {
  it('turns turnQuality metadata into replay memory audit evidence', () => {
    const summary: TurnQualitySummary = {
      memory: {
        mode: 'auto',
        blocks: [{
          blockType: 'seed-memory',
          trigger: 'session_start',
          source: 'memory-packer',
          injected: true,
          chars: 64,
          count: 1,
        }],
      },
      strategy: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        requestedProvider: 'openai',
        requestedModel: 'gpt-4.1',
        profile: 'deep',
      },
      score: {
        score: 86,
        max: 100,
        grade: 'good',
        breakdown: [{
          dimension: 'memory',
          score: 18,
          max: 20,
          status: 'good',
          reasons: ['注入 1 个记忆块'],
        }],
      },
      agentScorecard: {
        agentId: 'coder',
        agentName: 'Coder',
        model: 'deepseek/deepseek-v4-pro',
        strategyProfile: 'deep',
        memoryUsed: 1,
        toolsUsed: 2,
        warnings: 0,
        score: {
          score: 86,
          max: 100,
          grade: 'good',
          breakdown: [],
        },
      },
    };

    const block = buildMemoryAuditBlock(summary, 123);

    expect(block.type).toBe('memory_audit');
    expect(block.memoryAudit?.mode).toBe('auto');
    expect(block.memoryAudit?.blocks[0].blockType).toBe('seed-memory');
    expect(block.memoryAudit?.score?.score).toBe(86);
    expect(block.memoryAudit?.agentScorecard?.agentId).toBe('coder');
    expect(block.content).toContain('deepseek/deepseek-v4-pro');
  });
});
