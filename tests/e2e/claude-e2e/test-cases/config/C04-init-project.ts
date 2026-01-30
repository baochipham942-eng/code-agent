import { TestCase } from '../../src/types.js';

export const C04: TestCase = {
  id: 'C04',
  name: '初始化项目',
  category: 'config',
  complexity: 'L2',

  prompt: `**必须创建以下三个文件/修改，缺一不可：**

1. **创建 .editorconfig 文件**（使用 write_file）
   - 设置 indent_size = 2
   - 设置 indent_style = space

2. **创建 .nvmrc 文件**（使用 write_file）
   - 内容只需要一行：20

3. **修改 package.json**（使用 edit_file）
   - 添加 "engines": { "node": ">=20" }

所有三个操作都必须完成，否则任务失败。`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: '.editorconfig',
    },
    {
      type: 'file-contains',
      target: '.editorconfig',
      contains: ['indent_size = 2', 'indent_style = space'],
    },
    {
      type: 'file-exists',
      target: '.nvmrc',
    },
    {
      type: 'file-contains',
      target: '.nvmrc',
      contains: ['20'],
    },
    {
      type: 'file-contains',
      target: 'package.json',
      contains: ['engines', 'node'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Write', 'Edit'],
    toolCallRange: { min: 3, max: 8 },
  },

  tags: ['config', 'project-setup', 'editorconfig', 'nvmrc'],
  timeout: 180000, // Increased from 120s to 180s
  retries: 2, // Increased from 1 to 2
  nudgeOnMissingFile: true,
};

export default C04;
