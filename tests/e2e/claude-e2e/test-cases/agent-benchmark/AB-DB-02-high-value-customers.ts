import { TestCase } from '../../src/types.js';

/**
 * T2-C: 数据库操作 (AgentBench DB)
 * 测试子查询、聚合函数、多表关联能力
 */
export const ABDB02: TestCase = {
  id: 'AB-DB-02',
  name: '高价值客户分析',
  category: 'generation',
  complexity: 'L2',

  prompt: `为电商数据库编写 SQL 查询，找出过去 30 天内下单金额超过平均值 2 倍的客户，以及他们最常购买的产品类别。

数据库表结构：
- customers (id INT, name VARCHAR, email VARCHAR)
- orders (id INT, customer_id INT, total_amount DECIMAL, created_at TIMESTAMP)
- order_items (id INT, order_id INT, product_id INT, quantity INT, price DECIMAL)
- products (id INT, name VARCHAR, category_id INT)
- categories (id INT, name VARCHAR)

要求：
1. 创建文件 src/sql/high_value_customers.sql
2. 计算过去 30 天的平均订单金额
3. 找出订单总金额超过平均值 2 倍的客户
4. 对这些客户，找出他们购买最多的产品类别
5. 结果包含：客户名、邮箱、订单总金额、最常购买类别`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/sql/high_value_customers.sql',
    },
    {
      type: 'file-contains',
      target: 'src/sql/high_value_customers.sql',
      contains: ['AVG', 'GROUP BY'],
      ignoreCase: true,
    },
    {
      type: 'file-contains',
      target: 'src/sql/high_value_customers.sql',
      containsAny: ['30 DAY', "30 day", 'INTERVAL', 'DATE_SUB', 'DATEADD'],
      ignoreCase: true,
      message: '应包含 30 天时间过滤条件',
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

  tags: ['agent-benchmark', 'database', 'sql', 'aggregation', 'subquery'],
  timeout: 90000,
};

export default ABDB02;
