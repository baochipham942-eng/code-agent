import { TestCase } from '../../src/types.js';

export const D07: TestCase = {
  id: 'D07',
  name: '集成问题修复',
  category: 'debugging',
  complexity: 'L3',

  prompt: `项目中存在前后端集成问题，导致用户列表无法正常显示。

症状：
- 前端组件 UserList.tsx 无法获取用户数据
- API 调用返回格式与前端期望不匹配
- Store 中的状态更新不正确

请排查并修复以下文件中的集成问题：
1. src/api/routes/users.ts - 检查返回格式
2. src/api/services/user.service.ts - 检查数据处理
3. src/store/user.store.ts - 检查状态管理
4. src/components/UserList.tsx - 检查数据消费

确保数据流畅通：API -> Service -> Store -> Component`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'src/api/routes/users.ts',
      contains: ['getUsers', 'res'],
    },
    {
      type: 'file-contains',
      target: 'src/components/UserList.tsx',
      contains: ['useUserStore', 'users'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Edit', 'Glob'],
    toolCallRange: { min: 5, max: 20 },
  },

  tags: ['debugging', 'integration', 'fullstack', 'data-flow'],
  timeout: 180000,
};

export default D07;
