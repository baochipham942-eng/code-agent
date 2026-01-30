import { TestCase } from '../../src/types.js';

export const E01: TestCase = {
  id: 'E01',
  name: '空输入处理',
  category: 'edge-cases',
  complexity: 'L1',

  prompt: '',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'no-error',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 2 },
  },

  tags: ['edge-case', 'empty-input'],
  timeout: 30000,
};

export default E01;
