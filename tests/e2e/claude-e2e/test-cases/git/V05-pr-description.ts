import { TestCase } from '../../src/types.js';

export const V05: TestCase = {
  id: 'V05',
  name: 'PR 描述生成',
  category: 'git',
  complexity: 'L3',

  prompt: `基于当前分支的变更，生成一个完整的 Pull Request 描述。

需要：
1. 分析所有已提交的改动
2. 识别改动类型（功能/修复/重构等）
3. 生成符合以下格式的 PR 描述：

## 概述
简要说明这个 PR 的目的

## 改动内容
- 列出主要改动点
- 每个改动点简要说明

## 测试计划
- 如何测试这些改动
- 需要关注的边界情况

## 相关信息
- 关联的 issue（如有）
- 需要注意的事项

将生成的描述保存到 PR_DESCRIPTION.md 文件。`,

  fixture: 'typescript-basic',

  // createTempProject 已执行 git init + 初始 commit，这里只需创建分支和新提交
  setupCommands: [
    'git checkout -b feature/test-pr',
    'echo "export const newFeature = true;" >> src/index.ts',
    'git add .',
    'git commit -m "feat: add new feature flag"',
  ],

  validations: [
    {
      type: 'file-exists',
      target: 'PR_DESCRIPTION.md',
    },
    {
      type: 'file-contains',
      target: 'PR_DESCRIPTION.md',
      contains: ['##', '改动', '测试'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { min: 3, max: 20 },
  },

  tags: ['git', 'pr', 'documentation', 'workflow'],
  timeout: 180000,
  retries: 2,
  nudgeOnMissingFile: true,
};

export default V05;
