import { TestCase } from '../../src/types.js';

export const U03: TestCase = {
  id: 'U03',
  name: '数据流追踪',
  category: 'understanding',
  complexity: 'L2',

  prompt: `简要分析用户数据流向。

只需要读取以下 3 个文件：
- src/api/routes/users.ts
- src/api/services/user.service.ts
- src/components/UserList.tsx

输出格式（50字以内）：
API层 -> 服务层 -> 前端组件

⚠️ 只读取上述 3 个文件，不要读取其他文件！`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'output-contains',
      // OR 逻辑：只需要提到数据流相关概念之一
      containsAny: ['user', 'service', 'route', 'api', 'data', 'flow', 'component', 'store', '数据', '流', '服务', '路由', '组件'],
      ignoreCase: true,
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read'],
    // Glob or list_directory are both acceptable for exploration
    forbiddenTools: ['Write', 'Edit'],
    toolCallRange: { min: 2, max: 12 },
  },

  tags: ['understanding', 'dataflow', 'architecture'],
  timeout: 180000,
  retries: 1,
};

export default U03;
