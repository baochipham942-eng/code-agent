// ============================================================================
// Agent MD Loader Tests
// 测试自定义 agent .md frontmatter 解析（含 GAP-011 skills 字段）
// ============================================================================

import { describe, it, expect } from 'vitest';
import { parseAgentMd, parseAgentMdVisual, updateAgentMdVisual } from '../../../src/host/agent/hybrid/agentMdLoader';

describe('parseAgentMd', () => {
  it('should return null for content without frontmatter', () => {
    expect(parseAgentMd('just a prompt', 'foo.md')).toBeNull();
  });

  it('should parse basic frontmatter fields', () => {
    const content = [
      '---',
      'name: data-analyst',
      'description: 数据分析专家',
      'tools:',
      '  - Read',
      '  - Bash',
      'max-iterations: 20',
      '---',
      'You are a data analyst.',
    ].join('\n');

    const config = parseAgentMd(content, 'data-analyst.md');
    expect(config).not.toBeNull();
    expect(config!.id).toBe('data-analyst');
    expect(config!.tools).toEqual(['Read', 'Bash']);
    expect(config!.maxIterations).toBe(20);
    expect(config!.prompt).toBe('You are a data analyst.');
  });

  it('should parse skills field for expert subagents (GAP-011 方向 A)', () => {
    const content = [
      '---',
      'name: pdf-expert',
      'description: PDF 处理专家',
      'tools:',
      '  - Read',
      'skills:',
      '  - pdf-processing',
      '  - data-extraction',
      '---',
      'You are a PDF expert.',
    ].join('\n');

    const config = parseAgentMd(content, 'pdf-expert.md');
    expect(config).not.toBeNull();
    expect(config!.skills).toEqual(['pdf-processing', 'data-extraction']);
    // skills 与 tools 正交：声明 skills 不改变 tools
    expect(config!.tools).toEqual(['Read']);
  });

  it('should keep frontmatter name as display name（roles「描述当名字」修复）', () => {
    const content = [
      '---',
      'name: 数据分析师',
      'description: 数据处理、看板、周报专家',
      '---',
      '你是一名专业数据分析师。',
    ].join('\n');

    const config = parseAgentMd(content, '数据分析师.md');
    expect(config).not.toBeNull();
    expect(config!.id).toBe('数据分析师');
    expect(config!.name).toBe('数据分析师');
    expect(config!.description).toBe('数据处理、看板、周报专家');
  });

  it('should fall back name to filename and description to placeholder', () => {
    const content = ['---', 'model: balanced', '---', 'Prompt.'].join('\n');
    const config = parseAgentMd(content, 'my-agent.md');
    expect(config).not.toBeNull();
    expect(config!.name).toBe('my-agent');
    expect(config!.description).toBe('Custom agent: my-agent');
  });

  it('should leave skills undefined when not declared', () => {
    const content = [
      '---',
      'name: plain-agent',
      'description: 普通 agent',
      '---',
      'Prompt body.',
    ].join('\n');

    const config = parseAgentMd(content, 'plain-agent.md');
    expect(config).not.toBeNull();
    expect(config!.skills).toBeUndefined();
  });

  it('should parse declared inputs and outputs as string arrays', () => {
    const content = [
      '---',
      'name: report-writer',
      'description: 报告生成 agent',
      'inputs:',
      '  - 目标文件路径',
      '  - 读者画像',
      'outputs:',
      '  - markdown 报告',
      '  - 风险清单',
      '---',
      'Write a report.',
    ].join('\n');

    const config = parseAgentMd(content, 'report-writer.md');
    expect(config).not.toBeNull();
    expect(config!.inputs).toEqual(['目标文件路径', '读者画像']);
    expect(config!.outputs).toEqual(['markdown 报告', '风险清单']);
  });

  it('should leave inputs and outputs undefined when not declared or empty', () => {
    const content = [
      '---',
      'name: plain-io-agent',
      'description: 无 I/O 声明',
      'inputs: []',
      'outputs: []',
      '---',
      'Prompt body.',
    ].join('\n');

    const config = parseAgentMd(content, 'plain-io-agent.md');
    expect(config).not.toBeNull();
    expect(config!.inputs).toBeUndefined();
    expect(config!.outputs).toBeUndefined();
  });

  it('writes visual arrays as block lists so Chinese commas round-trip without splitting', () => {
    const original = [
      '---', 'name: 自建专家', 'unknown-key: keep-me', 'tools: [Read]', '---',
      '正文必须逐字保留，包含中文逗号，和换行。',
    ].join('\n');
    const saved = updateAgentMdVisual(original, {
      displayName: '小满', profession: '增长顾问', icon: 'Megaphone', category: 'content-marketing',
      tags: ['内容策略', '用户增长'], quickPrompts: ['帮我拆解增长问题，给出三步实验', '这句也有，中文逗号'],
    });

    expect(saved).toContain('tags:\n  - 内容策略\n  - 用户增长');
    expect(saved).toContain('quick-prompts:\n  - 帮我拆解增长问题，给出三步实验\n  - 这句也有，中文逗号');
    // 变异守卫：若 writer 退回 inline [a,b]，这条结构断言先红，随后 round-trip 也会把中文逗号切碎。
    expect(saved).not.toContain('quick-prompts: [');
    expect(parseAgentMdVisual(saved)).toEqual({
      displayName: '小满', profession: '增长顾问', icon: 'Megaphone', category: 'content-marketing',
      tags: ['内容策略', '用户增长'], quickPrompts: ['帮我拆解增长问题，给出三步实验', '这句也有，中文逗号'],
    });
    expect(saved).toContain('unknown-key: keep-me');
    expect(saved.slice(saved.indexOf('---\n', 4) + 4)).toBe('正文必须逐字保留，包含中文逗号，和换行。');
  });
});
