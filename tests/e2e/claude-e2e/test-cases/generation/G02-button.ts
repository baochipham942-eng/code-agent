import { TestCase } from '../../src/types.js';

export const G02: TestCase = {
  id: 'G02',
  name: '生成 Button 组件',
  category: 'generation',
  complexity: 'L1',

  prompt:
    '生成一个 React Button 组件，支持 primary/secondary/danger 三种 variant，支持 disabled 状态，写入 src/components/Button.tsx',

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/components/Button.tsx',
    },
    {
      type: 'file-contains',
      target: 'src/components/Button.tsx',
      contains: ['primary', 'secondary', 'danger', 'disabled', 'export'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 8 },
  },

  tags: ['generation', 'react', 'component'],
  timeout: 120000,
};

export default G02;
