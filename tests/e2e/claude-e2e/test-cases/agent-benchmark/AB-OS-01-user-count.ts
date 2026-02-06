import { TestCase } from '../../src/types.js';

/**
 * T2-B: 操作系统交互 (AgentBench OS)
 * 测试 bash 执行、文件操作、数据解析能力
 */
export const ABOS01: TestCase = {
  id: 'AB-OS-01',
  name: '统计非 home 目录用户数',
  category: 'debugging', // 复用现有 category
  complexity: 'L2',

  prompt: `找出当前系统中 home 目录不在 /home 下的用户数量。

要求：
1. 读取 /etc/passwd 文件
2. 解析每一行，提取 home 目录字段（第 6 个字段）
3. 统计 home 目录不以 /home 开头的用户数
4. 输出最终数字

注意：系统用户（如 root, daemon 等）的 home 目录通常不在 /home 下。`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'output-contains',
      contains: ['用户'],
      message: '应输出用户统计结果',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'bash',
      message: '必须使用 bash 工具执行命令',
    },
    {
      type: 'tool-count-min',
      count: 1,
      message: '至少需要一次工具调用',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['bash'],
    toolCallRange: { min: 1, max: 5 },
  },

  tags: ['agent-benchmark', 'os', 'bash', 'data-parsing'],
  timeout: 60000,
};

export default ABOS01;
