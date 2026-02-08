import { TestCase } from '../../src/types.js';

/**
 * 混合场景：模拟真实 GitHub Issue 修复流程
 * 测试 web_search + code_analysis + edit 综合能力
 */
export const HYB01: TestCase = {
  id: 'HYB-01',
  name: 'GitHub Issue 修复流程',
  category: 'multi-file',
  complexity: 'L3',

  prompt: `模拟修复一个 GitHub Issue 的完整流程。

Issue 描述：
用户报告 src/utils/date.ts 中的 formatDate 函数在处理时区时有问题。
当传入 UTC 时间字符串时，输出的本地时间不正确。

任务：
1. 分析现有代码，理解当前实现
2. 复现问题（写一个测试用例证明 bug 存在）
3. 修复 bug
4. 确保测试通过
5. 写一个简短的 PR 描述说明改动

需要创建/修改的文件：
- src/utils/date.ts - 修复 bug
- src/utils/__tests__/date.test.ts - 添加测试用例
- docs/pr-description.md - PR 描述`,

  fixture: 'typescript-basic',

  setupCommands: [
    'mkdir -p src/utils/__tests__',
    // 创建有 bug 的日期处理代码
    `cat > src/utils/date.ts << 'EOF'
/**
 * 格式化日期
 * @param date - Date 对象或 ISO 字符串
 * @param format - 格式字符串 (YYYY-MM-DD HH:mm:ss)
 */
export function formatDate(
  date: Date | string,
  format: string = 'YYYY-MM-DD'
): string {
  // BUG: 没有正确处理时区
  const d = typeof date === 'string' ? new Date(date) : date;

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');

  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds);
}

/**
 * 解析日期字符串为 UTC Date
 */
export function parseUTCDate(dateString: string): Date {
  return new Date(dateString);
}
EOF`,
  ],

  validations: [
    {
      type: 'file-exists',
      target: 'src/utils/__tests__/date.test.ts',
      message: '应创建测试文件',
    },
    {
      type: 'file-exists',
      target: 'docs/pr-description.md',
      message: '应创建 PR 描述',
    },
    {
      type: 'file-contains',
      target: 'src/utils/date.ts',
      containsAny: ['UTC', 'getUTC', 'toISOString', 'timezone', 'offset'],
      ignoreCase: true,
      message: '修复代码应处理时区问题',
    },
    {
      type: 'file-contains',
      target: 'src/utils/__tests__/date.test.ts',
      contains: ['test', 'expect'],
      message: '测试文件应包含测试用例',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: ['Read', 'read_file'],
      message: '应先读取现有代码',
    },
    {
      type: 'no-blind-edit',
      message: '不应盲改代码，应先分析',
    },
    {
      type: 'tool-count-min',
      count: 4,
      message: '至少需要：读取 → 测试 → 修复 → PR描述',
    },
  ],

  expectedBehavior: {
    requiredTools: ['Read', 'Edit', 'Write'],
    forbiddenTools: [],
    toolCallRange: { min: 4, max: 15 },
  },

  tags: ['agent-benchmark', 'hybrid', 'github', 'bug-fix', 'workflow'],
  timeout: 240000,
};

export default HYB01;
