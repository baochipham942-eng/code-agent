import { TestCase } from '../../src/types.js';

export const T06: TestCase = {
  id: 'T06',
  name: '完整测试套件',
  category: 'documentation',
  complexity: 'L4',

  prompt: `为项目创建完整的测试套件。

需要创建：

1. 单元测试
   - src/api/services/user.service.test.ts
   - src/store/user.store.test.ts

2. 集成测试
   - src/api/routes/users.test.ts
   - 测试完整的请求-响应流程

3. 组件测试
   - src/components/UserList.test.tsx
   - 使用 React Testing Library

4. 测试工具
   - src/test/setup.ts - 测试配置
   - src/test/mocks/ - Mock 数据和函数

测试要求：
- 覆盖主要功能路径
- 包含边界情况
- 模拟外部依赖
- 使用 describe/it 组织测试`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/services/user.service.test.ts',
    },
    {
      type: 'file-exists',
      target: 'src/api/routes/users.test.ts',
    },
    {
      type: 'file-exists',
      target: 'src/components/UserList.test.tsx',
    },
    {
      type: 'file-contains',
      target: 'src/api/services/user.service.test.ts',
      contains: ['describe', 'it', 'expect'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Glob'],
    toolCallRange: { min: 8, max: 30 },
  },

  tags: ['documentation', 'testing', 'unit-test', 'integration-test'],
  timeout: 600000, // 10分钟（L4 复杂任务）
};

export default T06;
