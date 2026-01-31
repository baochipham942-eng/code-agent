import { TestCase } from '../../src/types.js';

export const G01: TestCase = {
  id: 'G01',
  name: '生成 debounce 工具函数',
  category: 'generation',
  complexity: 'L1',

  prompt: `生成 src/utils/debounce.ts，实现以下函数签名：

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  options?: { leading?: boolean; trailing?: boolean }
): (...args: Parameters<T>) => void;

要求：
- leading: true 时在 wait 开始时立即执行
- trailing: true 时在 wait 结束后执行（默认行为）
- 必须使用 write_file 创建文件
- 必须导出 debounce 函数`,

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
