import { TestCase } from '../../src/types.js';

/**
 * L5 级别测试用例：完整认证系统 + RBAC
 *
 * 参考 SWE-bench Pro 难度标准：
 * - 100-200 行代码修改
 * - 8-10 个文件
 * - 涉及多个系统组件的协调
 * - 需要理解复杂的业务逻辑和安全最佳实践
 */
export const M06: TestCase = {
  id: 'M06',
  name: '认证系统+RBAC',
  category: 'multi-file',
  complexity: 'L5',

  prompt: `实现一个完整的认证系统，包含 RBAC（基于角色的访问控制）。

## 需要实现的功能

### 1. 数据模型 (prisma/schema.prisma)
- User: id, email, password (hashed), name, status, createdAt, updatedAt
- Role: id, name, description, permissions (JSON), createdAt
- UserRole: userId, roleId (多对多关系)
- Session: id, userId, token, expiresAt, userAgent, ipAddress
- AuditLog: id, userId, action, resource, details, ipAddress, timestamp

### 2. 认证模块 (src/auth/)
- src/auth/password.ts - bcrypt 密码哈希和验证
- src/auth/jwt.ts - JWT 生成、验证、刷新
- src/auth/session.ts - Session 管理（创建、验证、撤销）
- src/auth/middleware.ts - Express 认证中间件

### 3. RBAC 模块 (src/rbac/)
- src/rbac/permissions.ts - 权限定义和常量
- src/rbac/roles.ts - 预定义角色（admin, editor, viewer）
- src/rbac/guard.ts - 权限检查中间件
- src/rbac/policy.ts - 资源级别的访问策略

### 4. API 路由 (src/api/routes/)
- src/api/routes/auth.ts
  - POST /auth/register - 用户注册
  - POST /auth/login - 登录（返回 JWT + refresh token）
  - POST /auth/refresh - 刷新 token
  - POST /auth/logout - 登出（撤销 session）
  - GET /auth/me - 获取当前用户信息

- src/api/routes/users.ts (需要 admin 权限)
  - GET /users - 列出用户
  - GET /users/:id - 获取用户详情
  - PATCH /users/:id - 更新用户
  - DELETE /users/:id - 删除用户
  - POST /users/:id/roles - 分配角色

- src/api/routes/roles.ts (需要 admin 权限)
  - GET /roles - 列出角色
  - POST /roles - 创建角色
  - PATCH /roles/:id - 更新角色权限

### 5. 前端组件 (src/components/)
- src/components/auth/LoginForm.tsx
- src/components/auth/RegisterForm.tsx
- src/components/admin/UserManagement.tsx
- src/components/admin/RoleManagement.tsx

### 6. 安全要求
- 密码使用 bcrypt 哈希（cost factor >= 10）
- JWT 包含 userId, roles, permissions
- Refresh token 存储在 httpOnly cookie
- 实现 rate limiting（登录失败 5 次后锁定 15 分钟）
- 所有敏感操作记录到 AuditLog
- 防止 timing attack（密码比较使用 constant-time）

### 7. 测试覆盖
- src/__tests__/auth.test.ts - 认证流程测试
- src/__tests__/rbac.test.ts - 权限检查测试`,

  fixture: 'fullstack-app',

  validations: [
    // 数据模型
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['User', 'Role', 'UserRole', 'Session', 'AuditLog', 'permissions'],
    },
    // 认证模块
    {
      type: 'file-exists',
      target: 'src/auth/password.ts',
    },
    {
      type: 'file-contains',
      target: 'src/auth/password.ts',
      contains: ['bcrypt', 'hash', 'compare'],
    },
    {
      type: 'file-exists',
      target: 'src/auth/jwt.ts',
    },
    {
      type: 'file-exists',
      target: 'src/auth/middleware.ts',
    },
    // RBAC 模块
    {
      type: 'file-exists',
      target: 'src/rbac/permissions.ts',
    },
    {
      type: 'file-exists',
      target: 'src/rbac/guard.ts',
    },
    {
      type: 'file-contains',
      target: 'src/rbac/roles.ts',
      contains: ['admin', 'editor', 'viewer'],
    },
    // API 路由
    {
      type: 'file-exists',
      target: 'src/api/routes/auth.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/auth.ts',
      contains: ['register', 'login', 'refresh', 'logout'],
    },
    {
      type: 'file-exists',
      target: 'src/api/routes/users.ts',
    },
    // 前端组件
    {
      type: 'file-exists',
      target: 'src/components/auth/LoginForm.tsx',
    },
    {
      type: 'file-exists',
      target: 'src/components/admin/UserManagement.tsx',
    },
  ],

  expectedBehavior: {
    agentDispatched: true,
    agentTypes: ['coder', 'code-explore'],
    toolsUsed: ['Read', 'Write', 'Edit', 'Glob'],
    toolCallRange: { min: 15 }, // max 由复杂度自动计算: L5(100) + 10步(80) = 180
    noBlindEdit: true,
  },

  tags: ['multi-file', 'auth', 'rbac', 'security', 'jwt', 'L5'],
  timeout: 1200000, // 20分钟（L5 复杂任务）

  stepByStepExecution: true,
  steps: [
    {
      instruction: '修改 prisma/schema.prisma 添加 User, Role, UserRole, Session, AuditLog 模型',
      validation: { type: 'file-contains', target: 'prisma/schema.prisma', contains: ['User', 'Role', 'Session'] },
    },
    {
      instruction: '创建密码哈希模块 src/auth/password.ts（使用 bcrypt）',
      validation: { type: 'file-exists', target: 'src/auth/password.ts' },
    },
    {
      instruction: '创建 JWT 模块 src/auth/jwt.ts（生成、验证、刷新）',
      validation: { type: 'file-exists', target: 'src/auth/jwt.ts' },
    },
    {
      instruction: '创建认证中间件 src/auth/middleware.ts',
      validation: { type: 'file-exists', target: 'src/auth/middleware.ts' },
    },
    {
      instruction: '创建 RBAC 权限定义 src/rbac/permissions.ts 和角色 src/rbac/roles.ts',
      validation: { type: 'file-exists', target: 'src/rbac/permissions.ts' },
    },
    {
      instruction: '创建权限检查中间件 src/rbac/guard.ts',
      validation: { type: 'file-exists', target: 'src/rbac/guard.ts' },
    },
    {
      instruction: '创建认证 API 路由 src/api/routes/auth.ts（register, login, refresh, logout）',
      validation: { type: 'file-exists', target: 'src/api/routes/auth.ts' },
    },
    {
      instruction: '创建用户管理 API 路由 src/api/routes/users.ts（需要 admin 权限）',
      validation: { type: 'file-exists', target: 'src/api/routes/users.ts' },
    },
    {
      instruction: '创建前端登录组件 src/components/auth/LoginForm.tsx',
      validation: { type: 'file-exists', target: 'src/components/auth/LoginForm.tsx' },
    },
    {
      instruction: '创建用户管理组件 src/components/admin/UserManagement.tsx',
      validation: { type: 'file-exists', target: 'src/components/admin/UserManagement.tsx' },
    },
  ],

  nudgeOnMissingFile: true,
};

export default M06;
