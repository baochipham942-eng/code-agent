import { TestCase } from '../../src/types.js';

export const U04: TestCase = {
  id: 'U04',
  name: '依赖分析',
  category: 'understanding',
  complexity: 'L2',

  prompt: `简要分析模块依赖关系。

只读取以下文件，列出 import 语句：
- src/api/routes/users.ts
- src/api/services/user.service.ts
- src/store/user.store.ts

输出格式：
文件名 -> 依赖的模块

⚠️ 只分析上述 3 个文件的 import，不要读取其他文件！`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'output-contains',
      // 放宽验证：OR 逻辑
      containsAny: ['import', 'dependency', 'module', 'depend', 'require', '依赖', '模块', '导入', 'export', 'from', '引用', 'user'],
      ignoreCase: true,
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
  timeout: 180000,
  retries: 1,
};

export default U04;
