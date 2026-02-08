import { TestCase } from '../../src/types.js';

/**
 * T2-D: GUI 桌面操作 (OSWorld)
 * 测试截图分析能力 - 识别 UI 元素
 */
export const ABGUI01: TestCase = {
  id: 'AB-GUI-01',
  name: '截图 UI 元素分析',
  category: 'debugging',
  complexity: 'L2',

  prompt: `对当前桌面进行截图，并分析截图中的 UI 元素。

要求：
1. 使用截图工具捕获当前屏幕
2. 分析截图中可见的主要元素：
   - 识别打开的应用程序窗口
   - 识别菜单栏、工具栏等 UI 组件
   - 识别任何可见的文本内容
3. 输出结构化的分析报告，包括：
   - 屏幕分辨率（如果可获取）
   - 主要窗口列表
   - 关键 UI 元素描述

注意：这是一个视觉理解任务，需要调用截图工具。`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      contains: ['窗口', '屏幕', '应用', 'UI', '元素', '界面'],
      matchMode: 'any',
      message: '应包含 UI 元素分析内容',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'screenshot',
      message: '必须使用 screenshot 工具捕获屏幕',
    },
    {
      type: 'tool-count-min',
      count: 1,
      message: '至少需要一次截图调用',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['screenshot'],
    toolCallRange: { min: 1, max: 3 },
  },

  tags: ['agent-benchmark', 'gui', 'screenshot', 'visual-understanding'],
  timeout: 120000,
};

export default ABGUI01;
