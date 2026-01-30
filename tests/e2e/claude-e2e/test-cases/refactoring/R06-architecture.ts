import { TestCase } from '../../src/types.js';

export const R06: TestCase = {
  id: 'R06',
  name: '架构重构',
  category: 'refactoring',
  complexity: 'L4',

  prompt: `重构项目架构，实现清晰的分层和依赖注入。

目标架构：
1. Domain Layer (src/domain/)
   - entities/ - 业务实体
   - repositories/ - 仓库接口
   - services/ - 领域服务

2. Application Layer (src/application/)
   - use-cases/ - 用例实现
   - dto/ - 数据传输对象

3. Infrastructure Layer (src/infrastructure/)
   - repositories/ - 仓库实现
   - external/ - 外部服务适配器

4. Presentation Layer (保持现有 src/api/, src/components/)

需要：
1. 创建目录结构
2. 将现有代码按职责迁移
3. 定义接口和实现
4. 更新导入路径

确保代码编译通过，保持原有功能。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/domain/entities/User.ts',
    },
    {
      type: 'file-exists',
      target: 'src/domain/repositories/UserRepository.ts',
    },
    {
      type: 'file-exists',
      target: 'src/application/use-cases/GetUsers.ts',
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Edit', 'Glob', 'Bash'],
    toolCallRange: { min: 10, max: 30 },
  },

  tags: ['refactoring', 'architecture', 'clean-architecture', 'ddd'],
  timeout: 300000,
};

export default R06;
