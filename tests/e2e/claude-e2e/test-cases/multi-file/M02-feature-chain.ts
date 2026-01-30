import { TestCase } from '../../src/types.js';

export const M02: TestCase = {
  id: 'M02',
  name: '功能串联',
  category: 'multi-file',
  complexity: 'L3',

  prompt: `实现一个完整的"用户收藏"功能，需要串联多个层级。

需要修改/创建的文件：

1. prisma/schema.prisma
   - 添加 Favorite 模型（userId, postId, createdAt）
   - 更新 User 和 Post 的关系

2. src/api/services/favorite.service.ts
   - addFavorite(userId, postId)
   - removeFavorite(userId, postId)
   - getFavorites(userId)
   - isFavorited(userId, postId)

3. src/api/routes/favorites.ts
   - POST /favorites - 添加收藏
   - DELETE /favorites/:postId - 取消收藏
   - GET /favorites - 获取收藏列表

4. src/store/favorite.store.ts
   - 状态管理

5. src/components/FavoriteButton.tsx
   - 收藏/取消收藏按钮组件

确保数据流完整：UI -> Store -> API -> Service -> DB`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['Favorite', 'userId', 'postId'],
    },
    {
      type: 'file-exists',
      target: 'src/api/services/favorite.service.ts',
    },
    {
      type: 'file-exists',
      target: 'src/api/routes/favorites.ts',
    },
    {
      type: 'file-exists',
      target: 'src/store/favorite.store.ts',
    },
    {
      type: 'file-exists',
      target: 'src/components/FavoriteButton.tsx',
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Edit', 'Glob'],
    toolCallRange: { min: 8, max: 22 },
  },

  tags: ['multi-file', 'fullstack', 'feature', 'crud'],
  timeout: 180000,
};

export default M02;
