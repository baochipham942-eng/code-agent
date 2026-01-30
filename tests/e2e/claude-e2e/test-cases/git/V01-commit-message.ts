import { TestCase } from '../../src/types.js';

export const V01: TestCase = {
  id: 'V01',
  name: '生成 commit message',
  category: 'git',
  complexity: 'L1',

  prompt:
    '查看当前 git 仓库的改动，生成一个符合 Conventional Commits 规范的 commit message',

  fixture: 'typescript-basic',

  setupCommands: [
    'echo "export const NEW_FEATURE = true;" >> src/index.ts',
    'git add src/index.ts',
  ],

  validations: [],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 10 },
  },

  tags: ['git', 'commit', 'conventional-commits'],
  timeout: 120000,
};

export default V01;
