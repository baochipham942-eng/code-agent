import { TestCase } from '../../src/types.js';

/**
 * T2-C: 数据库操作 (AgentBench DB)
 * 测试 LAG 窗口函数、日期处理、CASE 表达式能力
 */
export const ABDB03: TestCase = {
  id: 'AB-DB-03',
  name: '季度环比增长率分析',
  category: 'generation',
  complexity: 'L3',

  prompt: `编写 SQL 查询分析销售表的季度环比增长率，并标记增长率下降的季度。

数据库表结构：
- sales (id INT, amount DECIMAL, sale_date DATE, region VARCHAR)

要求：
1. 创建文件 src/sql/quarterly_growth.sql
2. 按季度汇总销售总额
3. 计算每个季度相对于上一季度的环比增长率
4. 标记增长率为负数的季度（添加 'declining' 标记）
5. 结果包含：年份、季度、销售总额、增长率、是否下降标记
6. 按年份和季度排序`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/sql/quarterly_growth.sql',
    },
    {
      type: 'file-contains',
      target: 'src/sql/quarterly_growth.sql',
      contains: ['LAG'],
      ignoreCase: true,
      message: '应使用 LAG 窗口函数计算环比',
    },
    {
      type: 'file-contains',
      target: 'src/sql/quarterly_growth.sql',
      contains: ['CASE', 'WHEN'],
      ignoreCase: true,
      message: '应使用 CASE 表达式标记下降',
    },
    {
      type: 'file-contains',
      target: 'src/sql/quarterly_growth.sql',
      containsAny: ['QUARTER', 'DATEPART', 'EXTRACT'],
      ignoreCase: true,
      message: '应包含季度提取逻辑',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['agent-benchmark', 'database', 'sql', 'window-function', 'analytics'],
  timeout: 120000,
};

export default ABDB03;
