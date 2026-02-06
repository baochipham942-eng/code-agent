import { TestCase } from '../../src/types.js';

/**
 * T3-A: 软件开发协作 (ChatDev/MetaGPT 风格)
 * 测试多 Agent 角色分工：architect → coder → reviewer → tester
 */
export const CD02: TestCase = {
  id: 'CD-02',
  name: 'Markdown 到 HTML 转换器',
  category: 'multi-file',
  complexity: 'L3',

  prompt: `开发一个 Markdown 到 HTML 转换器库。

功能需求：
1. 支持标题（h1-h6）
2. 支持列表（有序和无序）
3. 支持代码块（行内和块级）
4. 支持链接和图片
5. 支持粗体和斜体

技术要求：
1. TypeScript 编写
2. 不使用第三方 Markdown 解析库
3. 提供简洁的 API：convert(markdown: string): string
4. 包含完整的单元测试

需要创建的文件：
- src/markdown/index.ts - 主入口和导出
- src/markdown/parser.ts - 解析器核心
- src/markdown/tokenizer.ts - 词法分析
- src/markdown/renderer.ts - HTML 渲染
- src/markdown/types.ts - 类型定义
- src/markdown/__tests__/parser.test.ts - 测试`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/markdown/index.ts',
    },
    {
      type: 'file-exists',
      target: 'src/markdown/parser.ts',
    },
    {
      type: 'file-exists',
      target: 'src/markdown/renderer.ts',
    },
    {
      type: 'file-contains',
      target: 'src/markdown/parser.ts',
      containsAny: ['parse', 'token', 'heading', 'list'],
      ignoreCase: true,
    },
    {
      type: 'file-contains',
      target: 'src/markdown/renderer.ts',
      contains: ['<h', '<ul>', '<ol>', '<code>'],
    },
  ],

  processValidations: [
    {
      type: 'tool-count-min',
      count: 4,
      message: '至少需要 4 次工具调用创建核心文件',
    },
  ],

  expectedBehavior: {
    expectedAgents: ['coder', 'architect', 'reviewer'],
    toolCallRange: { min: 4, max: 20 },
  },

  tags: ['agent-benchmark', 'multi-agent', 'library', 'parser'],
  timeout: 300000,
  stepByStepExecution: true,
  steps: [
    {
      instruction: '创建类型定义 src/markdown/types.ts',
      validation: { type: 'file-exists', target: 'src/markdown/types.ts' },
    },
    {
      instruction: '创建词法分析器 src/markdown/tokenizer.ts',
      validation: { type: 'file-exists', target: 'src/markdown/tokenizer.ts' },
    },
    {
      instruction: '创建解析器 src/markdown/parser.ts',
      validation: { type: 'file-exists', target: 'src/markdown/parser.ts' },
    },
    {
      instruction: '创建渲染器 src/markdown/renderer.ts',
      validation: { type: 'file-exists', target: 'src/markdown/renderer.ts' },
    },
    {
      instruction: '创建主入口 src/markdown/index.ts 导出 convert 函数',
      validation: { type: 'file-exists', target: 'src/markdown/index.ts' },
    },
  ],
  nudgeOnMissingFile: true,
};

export default CD02;
