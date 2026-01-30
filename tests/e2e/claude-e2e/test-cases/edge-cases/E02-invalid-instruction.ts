import { TestCase } from '../../src/types.js';

export const E02: TestCase = {
  id: 'E02',
  name: '无效指令处理',
  category: 'edge-cases',
  complexity: 'L1',

  prompt: 'asdfghjkl zxcvbnm qwerty 12345',

  fixture: 'typescript-basic',

  validations: [],

  expectedBehavior: {
    directExecution: true,
    forbiddenTools: ['Write', 'Edit'],
    toolCallRange: { max: 5 },
  },

  tags: ['edge-case', 'invalid-input', 'error-handling'],
  timeout: 30000,
};

export default E02;
