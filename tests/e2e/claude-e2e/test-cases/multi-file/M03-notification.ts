import { TestCase } from '../../src/types.js';

export const M03: TestCase = {
  id: 'M03',
  name: '通知模块',
  category: 'multi-file',
  complexity: 'L3',

  prompt: `实现一个完整的站内通知系统。

需要创建的文件：

1. 数据层
   - prisma/schema.prisma 添加 Notification 模型
     - id, userId, type, title, content, read, createdAt

2. 服务层
   - src/api/services/notification.service.ts
     - create, markAsRead, markAllAsRead, getUnread, getAll

3. API 层
   - src/api/routes/notifications.ts
     - GET /notifications
     - PUT /notifications/:id/read
     - PUT /notifications/read-all

4. 前端
   - src/store/notification.store.ts - 状态管理
   - src/components/NotificationBell.tsx - 通知铃铛（显示未读数）
   - src/components/NotificationList.tsx - 通知列表

5. 实时更新（可选）
   - 使用轮询或简单的状态刷新

确保通知数据的完整流转和状态同步。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['Notification', 'read', 'type'],
    },
    {
      type: 'file-exists',
      target: 'src/api/services/notification.service.ts',
    },
    {
      type: 'file-exists',
      target: 'src/api/routes/notifications.ts',
    },
    {
      type: 'file-exists',
      target: 'src/components/NotificationBell.tsx',
    },
    {
      type: 'file-exists',
      target: 'src/components/NotificationList.tsx',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { min: 8, max: 22 },
  },

  tags: ['multi-file', 'fullstack', 'notification', 'realtime'],
  timeout: 180000,
};

export default M03;
