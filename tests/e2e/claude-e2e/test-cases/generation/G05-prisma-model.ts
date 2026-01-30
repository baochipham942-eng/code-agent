import { TestCase } from '../../src/types.js';

export const G05: TestCase = {
  id: 'G05',
  name: '创建 Prisma 数据模型',
  category: 'generation',
  complexity: 'L2',

  prompt: `在 prisma/schema.prisma 中添加 Comment 模型：
1. id - 自增主键
2. content - 评论内容 (必填)
3. authorId - 关联 User
4. postId - 关联 Post
5. createdAt - 创建时间
6. updatedAt - 更新时间

同时更新 User 和 Post 模型，添加 comments 关系。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['model Comment', 'content', 'authorId', 'postId', 'createdAt', 'updatedAt'],
    },
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['comments'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    toolCallRange: { min: 2, max: 6 },
  },

  tags: ['generation', 'prisma', 'database', 'schema'],
  timeout: 120000,
  retries: 1,
};

export default G05;
