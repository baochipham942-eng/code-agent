import { TestCase } from '../../src/types.js';

export const T04: TestCase = {
  id: 'T04',
  name: '集成测试编写',
  category: 'documentation',
  complexity: 'L2',

  prompt: `**任务：创建 src/api/services/user.service.test.ts**

步骤：
1. 读取 src/api/services/user.service.ts 了解接口
2. **使用 write_file 创建测试文件**

UserService 接口：
- findAll(): Promise<User[]>
- findById(id: number): Promise<User | undefined>
- create(data: { email: string; name?: string }): Promise<User>

测试文件要求（vitest）：
- 导入 { describe, it, expect } from 'vitest'
- 导入 { UserService } from './user.service'
- 测试 create、findAll、findById 方法

⚠️ 重要：读取服务文件后必须使用 write_file 创建测试文件！`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/api/services/user.service.test.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/services/user.service.test.ts',
      contains: ['describe', 'it', 'expect', 'UserService', 'create', 'findAll', 'findById'],
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

  tags: ['documentation', 'testing', 'integration-test', 'vitest'],
  timeout: 150000,
  retries: 2,
  nudgeOnMissingFile: true,
};

export default T04;
