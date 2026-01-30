import { TestCase } from '../../src/types.js';

export const R01: TestCase = {
  id: 'R01',
  name: '重命名变量/函数',
  category: 'refactoring',
  complexity: 'L1',

  prompt:
    '将 src/utils/api-client.ts 中的 API_BASE 常量重命名为 API_BASE_URL，同时更新所有引用它的地方',

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/utils/api-client.ts',
    },
    {
      type: 'file-contains',
      target: 'src/utils/api-client.ts',
      contains: ['API_BASE_URL'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 10 },
  },

  tags: ['refactoring', 'rename', 'typescript'],
  timeout: 60000,
};

export default R01;
