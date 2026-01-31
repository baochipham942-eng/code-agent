import { TestCase } from '../../src/types.js';

export const M00: TestCase = {
  id: 'M00',
  name: '导出导入（2文件）',
  category: 'multi-file',
  complexity: 'L1',

  prompt: `完成以下两个步骤（都必须完成）：

步骤1: 创建 src/utils/format.ts
- 导出 formatName 函数
- 参数: firstName: string, lastName: string
- 返回: "\${lastName}, \${firstName}" 格式的字符串

步骤2: 修改 src/index.ts（必须先 read_file 再 edit_file）
- 在文件顶部添加 import { formatName } from './utils/format'
- 添加并导出 greetFormal 函数，调用 formatName 格式化名字后返回问候语

⚠️ 两个步骤都必须完成！`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/utils/format.ts',
    },
    {
      type: 'file-contains',
      target: 'src/utils/format.ts',
      contains: ['export', 'formatName', 'firstName', 'lastName'],
    },
    {
      type: 'file-contains',
      target: 'src/index.ts',
      contains: ['import', 'formatName', 'greetFormal'],
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { min: 2, max: 10 },
  },

  tags: ['multi-file', 'import-export', 'typescript', 'basic'],
  timeout: 180000,
  retries: 2,
  nudgeOnMissingFile: true,
};

export default M00;
