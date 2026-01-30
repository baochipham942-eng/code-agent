import { TestCase } from '../../src/types.js';

export const U03: TestCase = {
  id: 'U03',
  name: '数据流追踪',
  category: 'understanding',
  complexity: 'L2',

  prompt: `分析 fullstack-app 中用户数据的流向：
1. 从 API 层 (routes/users.ts) 到服务层 (services/user.service.ts)
2. 数据如何存储和检索
3. 前端组件 (UserList.tsx) 如何获取和展示数据
4. 整体数据流架构

请画出数据流图或用文字描述数据流转过程。`,

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
  timeout: 150000,
};

export default U03;
