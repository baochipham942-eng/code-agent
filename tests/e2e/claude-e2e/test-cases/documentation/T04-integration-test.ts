import { TestCase } from '../../src/types.js';

export const T04: TestCase = {
  id: 'T04',
  name: '集成测试编写',
  category: 'documentation',
  complexity: 'L2',

  prompt: `**任务：创建测试文件 src/api/services/user.service.test.ts**

步骤：
1. 读取 src/api/services/user.service.ts 了解 UserService 类
2. 使用 write_file 创建测试文件

测试文件必须包含：
\`\`\`typescript
import { describe, it, expect } from 'vitest';
import { UserService } from './user.service';

describe('UserService', () => {
  // 测试 create 方法
  // 测试 findAll 方法
  // 测试 findById 方法
});
\`\`\`

⚠️ 必须执行 write_file 创建文件，文件路径：src/api/services/user.service.test.ts`,

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
