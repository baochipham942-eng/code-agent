import { TestCase } from '../../src/types.js';

/**
 * T2-C: 数据库操作 (AgentBench DB)
 * 测试 SQL 生成、窗口函数使用能力
 */
export const ABDB01: TestCase = {
  id: 'AB-DB-01',
  name: '查询部门薪资 TOP3',
  category: 'generation',
  complexity: 'L2',

  prompt: `为一个员工数据库编写 SQL 查询，找出每个部门薪资最高的前 3 名员工。

数据库表结构：
- employees (id INT, name VARCHAR, department_id INT, salary DECIMAL)
- departments (id INT, name VARCHAR)

要求：
1. 创建文件 src/sql/top_salary.sql
2. 使用窗口函数或子查询
3. 结果需包含：员工姓名、部门名称、薪资、排名
4. 按部门名称和排名排序`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/sql/top_salary.sql',
    },
    {
      type: 'file-contains',
      target: 'src/sql/top_salary.sql',
      containsAny: ['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LIMIT'],
      ignoreCase: true,
      message: '应使用窗口函数或 LIMIT',
    },
    {
      type: 'file-contains',
      target: 'src/sql/top_salary.sql',
      contains: ['JOIN', 'salary'],
      ignoreCase: true,
      message: '应包含 JOIN 和 salary 字段',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: ['write_file', 'Write'],
      message: '必须使用文件写入工具',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['agent-benchmark', 'database', 'sql', 'window-function'],
  timeout: 90000,
};

export default ABDB01;
