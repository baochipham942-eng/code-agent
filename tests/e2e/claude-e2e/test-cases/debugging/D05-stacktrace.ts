import { TestCase } from '../../src/types.js';

export const D05: TestCase = {
  id: 'D05',
  name: '根据 stack trace 修复',
  category: 'debugging',
  complexity: 'L2',

  prompt: `运行测试时出现以下错误：

TypeError: Cannot read properties of undefined (reading 'id')
    at UserService.findById (src/api/services/user.service.ts:16:28)
    at getUserById (src/api/routes/users.ts:10:28)

问题：getUserById 函数在用户不存在时返回 undefined，
但调用方没有正确处理这种情况。

请修复这个问题，当用户不存在时应该抛出一个明确的错误。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'compile-pass',
    },
    {
      type: 'file-contains',
      target: 'src/api/routes/users.ts',
      contains: ['throw', 'not found'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    forbiddenTools: ['Write'],
    toolCallRange: { min: 2, max: 8 },
    toolPattern: 'Read.*Edit',
  },

  tags: ['debugging', 'stacktrace', 'null-check', 'error-handling'],
  timeout: 120000,
  retries: 2,
};

export default D05;
