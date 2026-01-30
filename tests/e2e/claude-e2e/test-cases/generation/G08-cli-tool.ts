import { TestCase } from '../../src/types.js';

export const G08: TestCase = {
  id: 'G08',
  name: '生成 CLI 工具',
  category: 'generation',
  complexity: 'L1',

  prompt:
    '生成一个简单的 CLI 工具 src/cli.ts，支持 --help 显示帮助，--version 显示版本，--name <name> 打印问候语',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/cli.ts',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 15 },
  },

  tags: ['generation', 'cli', 'node'],
  timeout: 180000,
};

export default G08;
