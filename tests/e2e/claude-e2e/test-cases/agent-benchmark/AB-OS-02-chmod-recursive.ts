import { TestCase } from '../../src/types.js';

/**
 * T2-B: 操作系统交互 (AgentBench OS)
 * 测试条件过滤和递归操作能力
 */
export const ABOS02: TestCase = {
  id: 'AB-OS-02',
  name: '递归设置文件只读',
  category: 'debugging',
  complexity: 'L2',

  prompt: `在当前项目目录下，递归设置所有 .log 文件为只读（chmod 444）。

要求：
1. 查找当前目录及子目录下所有 .log 文件
2. 将这些文件设置为只读权限
3. 不要修改其他文件的权限
4. 输出修改了多少个文件`,

  fixture: 'typescript-basic',

  setupCommands: [
    'mkdir -p logs/sub',
    'echo "test log 1" > logs/app.log',
    'echo "test log 2" > logs/error.log',
    'echo "test log 3" > logs/sub/debug.log',
    'echo "not a log" > logs/readme.txt',
  ],

  validations: [
    {
      type: 'custom',
      custom: async (ctx) => {
        // 验证 .log 文件权限已被修改
        const { execSync } = await import('child_process');
        try {
          const result = execSync(`ls -la ${ctx.workDir}/logs/*.log`, { encoding: 'utf-8' });
          const isReadOnly = result.includes('r--r--r--');
          return {
            passed: isReadOnly,
            validation: { type: 'custom' },
            message: isReadOnly ? '.log 文件已设置为只读' : '.log 文件权限未正确设置',
          };
        } catch {
          return {
            passed: false,
            validation: { type: 'custom' },
            message: '无法验证文件权限',
          };
        }
      },
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'bash',
      message: '必须使用 bash 工具',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['bash'],
    toolCallRange: { min: 1, max: 6 },
  },

  tags: ['agent-benchmark', 'os', 'bash', 'permission'],
  timeout: 60000,
};

export default ABOS02;
