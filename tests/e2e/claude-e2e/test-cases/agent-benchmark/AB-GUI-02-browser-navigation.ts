import { TestCase } from '../../src/types.js';

/**
 * T2-D: GUI 桌面操作 (OSWorld)
 * 测试浏览器导航操作能力
 */
export const ABGUI02: TestCase = {
  id: 'AB-GUI-02',
  name: '浏览器导航与数据提取',
  category: 'debugging',
  complexity: 'L3',

  prompt: `使用浏览器操作工具完成以下任务：

1. 打开浏览器并导航到 https://news.ycombinator.com
2. 截取页面截图
3. 分析页面内容，提取：
   - 当前排名前 5 的文章标题
   - 每篇文章的得分（points）
   - 评论数量
4. 将结果整理成表格输出

要求：
- 使用 browser_action 工具进行页面操作
- 使用 screenshot 工具捕获页面内容
- 结合视觉理解分析页面结构`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      contains: ['Hacker News', 'HN', '标题', '文章', 'points', '评论'],
      matchMode: 'any',
      message: '应包含 Hacker News 文章信息',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'browser_action',
      message: '需要使用 browser_action 工具操作浏览器',
    },
    {
      type: 'tool-count-min',
      count: 2,
      message: '至少需要两次工具调用（导航 + 截图/分析）',
    },
  ],

  expectedBehavior: {
    directExecution: false,
    requiredTools: ['browser_action', 'screenshot'],
    toolCallRange: { min: 2, max: 6 },
  },

  tags: ['agent-benchmark', 'gui', 'browser', 'navigation', 'scraping'],
  timeout: 180000,
};

export default ABGUI02;
