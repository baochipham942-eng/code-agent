import { TestCase } from '../../src/types.js';

export const R05: TestCase = {
  id: 'R05',
  name: '迁移到 Hooks',
  category: 'refactoring',
  complexity: 'L3',

  prompt: `将 src/store/user.store.ts 中的状态管理逻辑重构为自定义 Hooks。

当前是简单的模块状态，需要改为：

1. 创建 src/hooks/useUsers.ts
   - 封装用户数据获取逻辑
   - 提供 loading, error, data 状态
   - 支持刷新和分页

2. 创建 src/hooks/useUser.ts
   - 获取单个用户详情
   - 支持缓存

3. 更新 src/components/UserList.tsx
   - 使用新的 hooks 替换直接的 store 调用

确保：
- 类型安全
- 正确处理 loading 和 error 状态
- 组件代码更简洁`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/hooks/useUsers.ts',
    },
    {
      type: 'file-contains',
      target: 'src/hooks/useUsers.ts',
      contains: ['loading', 'error', 'export'],
    },
    {
      type: 'file-exists',
      target: 'src/hooks/useUser.ts',
    },
    {
      type: 'file-contains',
      target: 'src/components/UserList.tsx',
      contains: ['useUsers'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Edit'],
    toolCallRange: { min: 5, max: 18 },
  },

  tags: ['refactoring', 'hooks', 'react', 'state-management'],
  timeout: 180000,
};

export default R05;
