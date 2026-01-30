import { TestCase } from '../../src/types.js';

export const E04: TestCase = {
  id: 'E04',
  name: '冲突指令处理',
  category: 'edge-cases',
  complexity: 'L1',

  prompt:
    '修改 src/index.ts：将 hello 函数改名为 greet，同时保持函数名为 hello 不变。请解释你将如何处理这个矛盾的需求。',

  fixture: 'typescript-basic',

  validations: [],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 10 },
  },

  tags: ['edge-case', 'conflicting-instructions', 'clarification'],
  timeout: 60000,
};

export default E04;
