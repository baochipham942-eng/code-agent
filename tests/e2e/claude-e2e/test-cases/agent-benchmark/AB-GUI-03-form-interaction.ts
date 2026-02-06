import { TestCase } from '../../src/types.js';

/**
 * T2-D: GUI 桌面操作 (OSWorld)
 * 测试浏览器表单交互能力
 */
export const ABGUI03: TestCase = {
  id: 'AB-GUI-03',
  name: '浏览器表单交互测试',
  category: 'debugging',
  complexity: 'L3',

  prompt: `使用浏览器操作工具完成一个简单的表单交互测试：

1. 导航到 https://httpbin.org/forms/post
2. 截图分析页面上的表单结构
3. 识别表单中的输入字段：
   - Customer name
   - Telephone
   - E-mail
   - Size (pizza size selection)
   - Topping (checkbox options)
4. 描述如何使用 browser_action 填写这些字段
5. 说明表单提交后预期的响应格式

要求：
- 分析表单的 HTML 结构
- 识别各字段的类型（文本框、单选、复选等）
- 不需要实际提交表单，只需分析和描述操作步骤`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      contains: ['表单', 'form', 'input', '字段', 'Customer', 'Telephone'],
      matchMode: 'any',
      message: '应包含表单字段分析',
    },
    {
      type: 'output-contains',
      contains: ['文本', '单选', '复选', 'checkbox', 'radio', 'text'],
      matchMode: 'any',
      message: '应识别字段类型',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'browser_action',
      message: '需要使用 browser_action 工具',
    },
    {
      type: 'tool-count-min',
      count: 1,
      message: '至少需要一次工具调用',
    },
  ],

  expectedBehavior: {
    directExecution: false,
    requiredTools: ['browser_action', 'screenshot'],
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['agent-benchmark', 'gui', 'browser', 'form', 'interaction'],
  timeout: 180000,
};

export default ABGUI03;
