import { TestCase } from '../../src/types.js';

/**
 * T2-A: 信息检索与推理 (GAIA Level 2)
 * 测试 web_fetch 工具获取网页数据的能力
 */
export const ABWEB01: TestCase = {
  id: 'AB-WEB-01',
  name: '获取 GitHub API 仓库信息',
  category: 'debugging',
  complexity: 'L2',

  prompt: `使用 GitHub REST API 获取 facebook/react 仓库的基本信息。

要求：
1. 访问 https://api.github.com/repos/facebook/react
2. 提取以下信息：
   - 仓库全名 (full_name)
   - Star 数量 (stargazers_count)
   - Fork 数量 (forks_count)
   - 主要编程语言 (language)
   - 创建时间 (created_at)
3. 将信息整理成表格形式输出

注意：GitHub API 是公开的，不需要认证即可访问基本信息。`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      contains: ['facebook/react'],
      message: '应包含仓库全名',
    },
    {
      type: 'output-contains',
      contains: ['JavaScript', 'TypeScript', 'star', 'fork'],
      matchMode: 'any',
      message: '应包含仓库统计信息',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'web_fetch',
      message: '必须使用 web_fetch 工具获取 API 数据',
    },
    {
      type: 'tool-count-min',
      count: 1,
      message: '至少需要一次 web_fetch 调用',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['web_fetch'],
    toolCallRange: { min: 1, max: 3 },
  },

  tags: ['agent-benchmark', 'web', 'api', 'data-fetch'],
  timeout: 120000,
};

export default ABWEB01;
