import { TestCase } from '../../src/types.js';

export const T01: TestCase = {
  id: 'T01',
  name: '添加 JSDoc 注释',
  category: 'documentation',
  complexity: 'L1',

  prompt:
    '为 src/utils/api-client.ts 中的 apiGet 和 apiPost 函数添加 JSDoc 注释，包含参数和返回值说明',

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/utils/api-client.ts',
    },
    {
      type: 'file-contains',
      target: 'src/utils/api-client.ts',
      contains: ['/**', '*/'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 10 },
  },

  tags: ['documentation', 'jsdoc', 'comments'],
  timeout: 60000,
};

export default T01;
