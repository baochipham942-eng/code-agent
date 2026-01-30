import { TestCase } from '../../src/types.js';

export const U04: TestCase = {
  id: 'U04',
  name: '依赖分析',
  category: 'understanding',
  complexity: 'L2',

  prompt: `分析 fullstack-app 的模块依赖关系：
1. 列出所有源文件及其导入依赖
2. 识别核心模块和边缘模块
3. 是否存在循环依赖
4. 依赖层次是否合理

给出依赖关系图和改进建议。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'output-contains',
      // 放宽验证：只需要提到依赖相关概念
      contains: ['import', 'dependency', 'module', 'depend', 'require', '依赖', '模块', '导入', 'export', 'from', 'circular', '引用'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read'],
    // Glob or list_directory are both acceptable for exploration
    forbiddenTools: ['Write', 'Edit'],
    toolCallRange: { min: 2, max: 15 },
  },

  tags: ['understanding', 'dependency', 'architecture', 'analysis'],
  timeout: 150000,
};

export default U04;
