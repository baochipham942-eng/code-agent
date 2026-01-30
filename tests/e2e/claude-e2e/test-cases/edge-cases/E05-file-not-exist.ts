import { TestCase, TestContext } from '../../src/types.js';

export const E05: TestCase = {
  id: 'E05',
  name: '处理不存在的文件',
  category: 'edge-cases',
  complexity: 'L2',

  prompt: '修改 src/nonexistent/file.ts 中的函数，添加错误处理',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      // OR 逻辑：只要包含任意一个表明文件问题的表达即可
      containsAny: [
        '不存在', 'not found', 'not exist', '找不到', 'No such file',
        '无法找到', 'cannot find', 'does not exist', '没有找到', '文件不存在',
        'nonexistent', '无法读取', 'cannot read', '无法打开', 'unable to',
        '路径不存在', 'error', '错误', 'fail', '失败',
        'missing', '缺失', 'invalid', '无效',
        'cannot', '无法', "can't", 'not able', '不能',
        '文件', '目录',
      ],
      ignoreCase: true,
    },
    {
      type: 'custom',
      custom: async (ctx: TestContext) => {
        const hasFile = ctx.files.has('src/nonexistent/file.ts');
        return {
          passed: !hasFile,
          validation: { type: 'custom' as const },
          message: hasFile ? '不应创建用户没有要求创建的文件' : undefined,
        };
      },
    },
  ],

  expectedBehavior: {
    forbiddenTools: ['Write'],
    toolCallRange: { max: 5 },
  },

  tags: ['edge-case', 'error-handling', 'file-not-found'],
  timeout: 60000,
};

export default E05;
