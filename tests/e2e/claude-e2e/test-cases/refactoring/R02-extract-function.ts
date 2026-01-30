import { TestCase } from '../../src/types.js';

export const R02: TestCase = {
  id: 'R02',
  name: '提取函数',
  category: 'refactoring',
  complexity: 'L1',

  prompt:
    '在 src/utils/api-client.ts 中，apiGet 和 apiPost 有重复的错误处理逻辑。请提取一个 handleResponse 函数来消除重复',

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/utils/api-client.ts',
    },
    {
      type: 'file-contains',
      target: 'src/utils/api-client.ts',
      contains: ['handleResponse'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 12 },
  },

  tags: ['refactoring', 'extract-function', 'dry'],
  timeout: 180000,
};

export default R02;
