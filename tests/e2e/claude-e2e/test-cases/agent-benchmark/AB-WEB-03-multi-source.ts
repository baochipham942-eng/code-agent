import { TestCase } from '../../src/types.js';

/**
 * T2-A: 信息检索与推理 (GAIA Level 2)
 * 测试多源信息整合能力：搜索 + 获取 + 推理
 */
export const ABWEB03: TestCase = {
  id: 'AB-WEB-03',
  name: '多源信息整合分析',
  category: 'debugging',
  complexity: 'L3',

  prompt: `对比分析 OpenAI 和 Anthropic 两家公司的最新大模型。

要求：
1. 搜索获取两家公司最新发布的模型信息
2. 对比以下维度：
   - 模型名称和发布时间
   - 上下文窗口长度
   - 主要特点/优势
   - 定价（API 价格）
3. 生成对比表格
4. 给出简短的总结建议

提示：可能需要访问官方文档或 API 定价页面获取准确信息。`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      contains: ['GPT', 'Claude', 'OpenAI', 'Anthropic'],
      matchMode: 'any',
      message: '应包含两家公司的模型信息',
    },
    {
      type: 'output-contains',
      contains: ['对比', '表格', '价格', 'token', '上下文'],
      matchMode: 'any',
      message: '应包含对比分析内容',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'web_search',
      message: '需要使用 web_search 搜索信息',
    },
    {
      type: 'tool-count-min',
      count: 2,
      message: '至少需要两次工具调用（搜索 + 获取）',
    },
  ],

  expectedBehavior: {
    directExecution: false,
    requiredTools: ['web_search', 'web_fetch'],
    toolCallRange: { min: 2, max: 8 },
  },

  tags: ['agent-benchmark', 'web', 'multi-source', 'comparison'],
  timeout: 300000,
};

export default ABWEB03;
