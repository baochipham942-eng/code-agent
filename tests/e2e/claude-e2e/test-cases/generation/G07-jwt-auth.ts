import { TestCase } from '../../src/types.js';

export const G07: TestCase = {
  id: 'G07',
  name: 'JWT 认证系统',
  category: 'generation',
  complexity: 'L4',

  prompt: `实现一个完整的 JWT 认证系统。

需要创建/修改以下文件：

1. src/api/auth/jwt.ts - JWT 工具函数
   - generateToken(payload): 生成 access token 和 refresh token
   - verifyToken(token): 验证并解码 token
   - refreshToken(refreshToken): 刷新 access token

2. src/api/auth/auth.service.ts - 认证服务
   - register(email, password): 注册用户
   - login(email, password): 登录返回 token
   - logout(userId): 注销（使 refresh token 失效）
   - validateSession(token): 验证会话

3. src/api/middleware/auth.ts - 更新认证中间件
   - 从 Authorization header 提取 token
   - 验证 token 并将用户信息注入请求

4. src/api/routes/auth.ts - 认证路由
   - POST /auth/register
   - POST /auth/login
   - POST /auth/refresh
   - POST /auth/logout

安全要求：
- 密码使用 bcrypt 哈希
- Token 应有适当的过期时间
- 实现 refresh token rotation`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/auth/jwt.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/auth/jwt.ts',
      contains: ['generateToken', 'verifyToken', 'refreshToken'],
    },
    {
      type: 'file-exists',
      target: 'src/api/auth/auth.service.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/auth/auth.service.ts',
      contains: ['register', 'login', 'logout'],
    },
    {
      type: 'file-exists',
      target: 'src/api/routes/auth.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/middleware/auth.ts',
      contains: ['Authorization', 'Bearer'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Edit', 'Glob'],
    toolCallRange: { min: 8, max: 30 },
  },

  tags: ['generation', 'jwt', 'auth', 'security', 'api'],
  timeout: 600000, // 10分钟（L4 复杂任务）
};

export default G07;
