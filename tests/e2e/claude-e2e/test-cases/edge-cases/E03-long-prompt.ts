import { TestCase } from '../../src/types.js';

// Generate a long prompt with repeated requirements
const generateLongPrompt = (): string => {
  const requirements = [
    '添加错误处理',
    '添加类型注解',
    '添加日志输出',
    '优化性能',
    '添加注释说明',
  ];

  const detailedRequirements = requirements
    .map(
      (req, i) =>
        `${i + 1}. ${req}：请确保代码质量，遵循最佳实践，保持代码整洁，易于维护。`
    )
    .join('\n');

  // Repeat to make it long
  const repeated = Array(10).fill(detailedRequirements).join('\n\n');

  return `请修改 src/index.ts，需要完成以下所有需求（注意：以下需求会重复列出以确保理解）：\n\n${repeated}\n\n最终只需要添加一个简单的错误处理即可。`;
};

export const E03: TestCase = {
  id: 'E03',
  name: '超长 prompt 处理',
  category: 'edge-cases',
  complexity: 'L1',

  prompt: generateLongPrompt(),

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/index.ts',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { max: 15 },
  },

  tags: ['edge-case', 'long-prompt', 'stress-test'],
  timeout: 180000,
};

export default E03;
