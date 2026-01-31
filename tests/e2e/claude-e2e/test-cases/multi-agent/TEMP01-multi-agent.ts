import { TestCase } from '../../src/types.js';

export const TEMP01: TestCase = {
  id: 'TEMP01',
  name: '多Agent协同测试',
  category: 'multi-agent',
  complexity: 'L4',
  tags: ['multi-agent', 'exploration', 'planning'],

  prompt: `对这个项目进行完整的安全审计和性能优化，要求：

【第一阶段：安全审计】
1. 扫描所有源代码文件，找出 SQL 注入、XSS、CSRF 等安全漏洞
2. 检查所有 API 端点的认证和授权机制
3. 分析敏感数据处理（密码、token、用户信息）
4. 检查依赖包是否有已知漏洞

【第二阶段：性能分析】
5. 分析所有数据库查询，找出 N+1 问题和慢查询
6. 检查前端组件的渲染性能问题
7. 分析 API 响应时间和内存占用

【第三阶段：代码质量】
8. 找出所有 any 类型使用
9. 检查错误处理是否完善
10. 分析代码重复度

【输出要求】
生成一份完整的 AUDIT_REPORT.md，包含：
- 每个问题的具体位置（文件:行号）
- 严重程度评级（Critical/High/Medium/Low）
- 修复建议和代码示例

这个任务涉及大量文件分析，建议使用子代理并行处理不同维度的检查。`,

  fixture: 'fullstack-app',
  generationId: 'gen7',
  timeout: 600000,

  validations: [
    {
      type: 'output-contains',
      contains: ['API', '模型'],
    },
  ],

  processValidation: {
    agentDispatched: true,
    expectedAgentTypes: ['explore'],
    minToolCalls: 3,
  },
};
