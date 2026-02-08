import { TestCase } from '../../src/types.js';

/**
 * T2-A: 信息检索与推理 (GAIA Level 2)
 * 测试 web_search 工具搜索并分析信息的能力
 */
export const ABWEB02: TestCase = {
  id: 'AB-WEB-02',
  name: '搜索并分析技术趋势',
  category: 'debugging',
  complexity: 'L2',

  prompt: `搜索 "LLM Agent 2024 benchmark" 相关信息，总结当前主流的 Agent 评测基准。

要求：
1. 使用网络搜索获取相关信息
2. 识别至少 3 个主流的 Agent 评测基准（如 GAIA, AgentBench, SWE-bench 等）
3. 简要说明每个基准的评测维度和特点
4. 输出结构化的总结报告

提示：关注 2024 年的最新研究进展。`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      contains: ['GAIA', 'AgentBench', 'SWE-bench', 'benchmark', '评测'],
      matchMode: 'any',
      message: '应包含主流评测基准名称',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'web_search',
      message: '必须使用 web_search 工具进行搜索',
    },
    {
      type: 'tool-count-min',
      count: 1,
      message: '至少需要一次搜索调用',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['web_search'],
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['agent-benchmark', 'web', 'search', 'analysis'],
  timeout: 180000,
};

export default ABWEB02;
