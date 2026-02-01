import { TestCase } from '../../src/types.js';

export const U06: TestCase = {
  id: 'U06',
  name: '安全审计',
  category: 'understanding',
  complexity: 'L4',

  prompt: `对这个项目进行全面的安全审计分析。

请检查以下方面：
1. 认证与授权
   - 中间件是否正确验证用户身份
   - 是否有未保护的敏感路由

2. 输入验证
   - API 路由是否验证输入参数
   - 是否有 SQL 注入/XSS 风险

3. 数据安全
   - 密码是否正确哈希存储
   - 敏感数据是否加密

4. 依赖安全
   - 检查 package.json 中是否有已知漏洞的依赖

5. 配置安全
   - 是否有硬编码的密钥或凭证
   - 环境变量使用是否正确

请提供详细的安全报告，包括：
- 发现的问题及其严重程度
- 具体的代码位置
- 修复建议`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'output-contains',
      contains: ['auth', 'middleware'],
    },
    {
      type: 'output-contains',
      // 中文输出使用"建议"而非英文 recommend
      contains: ['security', '建议'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['explore'], // code-review 是可选的，explore 是核心（安全审计需要全面探索）
    requiredTools: ['Glob', 'Read', 'Grep'],
    toolCallRange: { min: 10, max: 30 },
  },

  tags: ['understanding', 'security', 'audit', 'analysis'],
  timeout: 600000, // 10分钟（L4 复杂任务）
};

export default U06;
