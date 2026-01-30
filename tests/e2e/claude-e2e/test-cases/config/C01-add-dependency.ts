import { TestCase } from '../../src/types.js';

export const C01: TestCase = {
  id: 'C01',
  name: '添加依赖',
  category: 'config',
  complexity: 'L1',

  prompt: '在 package.json 中添加 lodash 作为生产依赖，版本 ^4.17.21',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'package.json',
    },
    {
      type: 'file-contains',
      target: 'package.json',
      contains: ['lodash', '4.17.21', 'dependencies'],
    },
    {
      type: 'custom',
      custom: async (ctx) => {
        const content = ctx.files.get('package.json');
        if (!content) {
          return {
            passed: false,
            validation: { type: 'custom' as const },
            message: 'package.json not found',
          };
        }
        try {
          const pkg = JSON.parse(content);
          const hasDep =
            pkg.dependencies && pkg.dependencies['lodash'] === '^4.17.21';
          return {
            passed: hasDep,
            validation: { type: 'custom' as const },
            message: hasDep
              ? undefined
              : 'lodash dependency not found with correct version',
          };
        } catch {
          return {
            passed: false,
            validation: { type: 'custom' as const },
            message: 'Invalid JSON in package.json',
          };
        }
      },
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['Read', 'Edit'],
    toolCallRange: { min: 2, max: 5 },
  },

  tags: ['config', 'package.json', 'dependencies'],
  timeout: 60000,
  retries: 1,  // 模型行为随机性，允许重试一次
};

export default C01;
