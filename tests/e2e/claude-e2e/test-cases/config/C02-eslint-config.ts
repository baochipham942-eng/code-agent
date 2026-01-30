import { TestCase } from '../../src/types.js';

export const C02: TestCase = {
  id: 'C02',
  name: 'ESLint 配置',
  category: 'config',
  complexity: 'L1',

  prompt:
    '创建 eslint.config.js，配置 TypeScript 支持，启用 no-unused-vars 规则',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'eslint.config.js',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 8 },
  },

  tags: ['config', 'eslint', 'typescript'],
  timeout: 120000,
};

export default C02;
