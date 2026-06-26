// ============================================================================
// Agent MD Loader Tests
// 测试自定义 agent .md frontmatter 解析（含 GAP-011 skills 字段）
// ============================================================================

import { describe, it, expect } from 'vitest';
import { parseAgentMd } from '../../../src/host/agent/hybrid/agentMdLoader';

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
});
