import { TestCase } from '../../src/types.js';

export const M05: TestCase = {
  id: 'M05',
  name: '性能优化',
  category: 'multi-file',
  complexity: 'L4',

  prompt: `对整个项目进行全面的性能优化。

优化任务：

1. API 层优化
   - src/api/routes/users.ts - 添加分页支持
   - src/api/services/user.service.ts - 添加缓存层
   - 创建 src/api/middleware/cache.ts - 响应缓存中间件

2. 数据库优化
   - prisma/schema.prisma - 添加必要索引
   - 优化查询（避免 N+1）

3. 前端优化
   - src/components/UserList.tsx
     - 实现虚拟滚动或分页
     - 使用 React.memo 优化渲染
     - 防抖搜索输入

4. 状态管理优化
   - src/store/user.store.ts
     - 实现选择性订阅
     - 添加数据规范化

5. 通用优化
   - 创建 src/utils/performance.ts
     - debounce, throttle
     - memoize
     - lazy load helper

确保优化后功能正常，提供性能改进说明。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/middleware/cache.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/users.ts',
      contains: ['page', 'limit'],
    },
    {
      type: 'file-exists',
      target: 'src/utils/performance.ts',
    },
    {
      type: 'file-contains',
      target: 'src/utils/performance.ts',
      contains: ['debounce', 'memoize'],
    },
    {
      type: 'file-contains',
      target: 'src/components/UserList.tsx',
      contains: ['memo'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Edit', 'Glob'],
    toolCallRange: { min: 12, max: 60 },
  },

  tags: ['multi-file', 'performance', 'optimization', 'caching', 'pagination'],
  timeout: 600000, // 10分钟（L4 复杂任务）
};

export default M05;
