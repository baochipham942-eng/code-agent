import { TestCase } from '../../src/types.js';

export const D04: TestCase = {
  id: 'D04',
  name: '修复异步竞态',
  category: 'debugging',
  complexity: 'L2',

  prompt: `修复 src/data-fetcher.ts 中 SearchComponent 的竞态 bug。

1. 用 read_file 读取 src/data-fetcher.ts
2. 用 edit_file 修复 SearchComponent：添加 currentSearchId 字段，在 search() 中检查 searchId 匹配后再更新结果
3. 删除所有 "// Bug:" 注释

必须调用 edit_file 修改文件！`,

  fixture: 'bug-async-race',

  validations: [
    {
      type: 'compile-pass',
    },
    {
      type: 'test-pass',
      target: 'src/data-fetcher.test.ts',
    },
    // 只检查关键修复 - SearchComponent 是否有 currentSearchId
    {
      type: 'file-contains',
      target: 'src/data-fetcher.ts',
      contains: ['currentSearchId'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    forbiddenTools: ['Write'],
    toolCallRange: { min: 2, max: 10 },
    toolPattern: 'Read.*Edit',
  },

  tags: ['debugging', 'async', 'race-condition', 'concurrency'],
  timeout: 180000,
  retries: 4,  // 增加重试次数以应对模型行为波动
  // cliOptions: {
  //   plan: true, // 暂时禁用规划模式测试
  // },
};

export default D04;
