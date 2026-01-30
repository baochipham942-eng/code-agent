import { TestCase } from '../../src/types.js';

export const G03: TestCase = {
  id: 'G03',
  name: '生成登录表单组件',
  category: 'generation',
  complexity: 'L2',

  prompt: `生成一个完整的登录表单组件，要求：
1. 包含用户名和密码输入框
2. 表单验证（用户名必填，密码至少6位）
3. 显示验证错误信息
4. 提交时调用 onSubmit 回调
5. 支持 loading 状态
6. 使用内联样式(style属性)或纯CSS类名，不要使用styled-jsx/styled-components等CSS-in-JS方案

写入 src/components/LoginForm.tsx`,

  fixture: 'react-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/components/LoginForm.tsx',
    },
    {
      type: 'file-contains',
      target: 'src/components/LoginForm.tsx',
      contains: ['username', 'password', 'onSubmit', 'error', 'loading', 'export'],
    },
    {
      type: 'compile-pass',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Write'],
    forbiddenTools: ['Bash'],
    toolCallRange: { max: 6 },
  },

  tags: ['generation', 'react', 'form', 'validation'],
  timeout: 120000,
  retries: 1,
};

export default G03;
