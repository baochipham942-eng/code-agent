import { TestCase } from '../../src/types.js';

export const G04: TestCase = {
  id: 'G04',
  name: '创建 REST API 端点',
  category: 'generation',
  complexity: 'L2',

  prompt: `创建 src/api/routes/posts.ts 文件。

1. 读取 src/api/routes/users.ts 了解代码风格
2. 用 write_file 创建 posts.ts，包含：
   - Post 接口定义：{ id: number; title: string; content: string }
   - posts 数组存储数据（模拟数据库）
   - getPosts、getPostById、createPost、updatePost、deletePost 函数

注意：不要导入不存在的模块，所有代码自包含在一个文件中。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/routes/posts.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/posts.ts',
      // 放宽验证：只要求核心 CRUD 函数存在，允许命名变体
      contains: ['Post', 'export'],
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/posts.ts',
      // 验证有获取、创建、删除操作（允许不同命名）
      containsAny: ['get', 'find', 'fetch', 'list', 'all'],
      ignoreCase: true,
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/posts.ts',
      containsAny: ['create', 'add', 'insert', 'new'],
      ignoreCase: true,
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Write'],
    toolCallRange: { min: 2, max: 8 },
  },

  tags: ['generation', 'rest-api', 'crud'],
  timeout: 120000,
  retries: 2,
  nudgeOnMissingFile: true,
};

export default G04;
