import { TestCase } from '../../src/types.js';

export const G01: TestCase = {
  id: 'G01',
  name: '生成 debounce 工具函数',
  category: 'generation',
  complexity: 'L1',

  prompt:
    '生成一个 debounce 函数，支持 leading 和 trailing 选项，写入 src/utils/debounce.ts',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/utils/debounce.ts',
    },
    {
      type: 'file-contains',
      target: 'src/utils/debounce.ts',
      contains: ['leading', 'trailing', 'export'],
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    // code-agent 使用 write_file 工具
    requiredTools: ['write_file'],
    toolCallRange: { max: 10 },
  },

  tags: ['generation', 'utility', 'typescript'],
  timeout: 300000,
};

export default G01;
