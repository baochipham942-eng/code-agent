import { TestCase } from '../../src/types.js';

/**
 * T3-B: 研究协作 (MultiAgentBench)
 * 测试多 Agent Group Discussion 模式
 */
export const MABR01: TestCase = {
  id: 'MAB-R01',
  name: '协作撰写研究提案',
  category: 'documentation',
  complexity: 'L3',

  prompt: `多个 Agent 协作撰写一份关于 "LLM Agent 安全性" 的研究提案。

任务分工：
- Agent A (researcher): 搜索相关背景资料
- Agent B (architect): 设计研究方法和框架
- Agent C (documenter): 整理撰写最终文档

研究提案需包含：
1. 背景介绍（当前 LLM Agent 的安全问题现状）
2. 研究问题（具体要解决的问题）
3. 研究方法（技术路线和实验设计）
4. 预期结果（期望的研究成果）
5. 参考文献（至少列出 5 个相关方向）

要求：
- 提案长度 800-1200 字
- 结构清晰，逻辑连贯
- 输出为 Markdown 格式

请创建文件 docs/research-proposal.md`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'docs/research-proposal.md',
    },
    {
      type: 'file-contains',
      target: 'docs/research-proposal.md',
      contains: ['背景', '方法', '预期'],
      message: '提案应包含完整结构',
    },
    {
      type: 'file-contains',
      target: 'docs/research-proposal.md',
      containsAny: ['LLM', 'Agent', '安全', 'security'],
      ignoreCase: true,
      message: '内容应与 LLM Agent 安全相关',
    },
    {
      type: 'custom',
      custom: async (ctx) => {
        const fs = await import('fs/promises');
        const path = await import('path');
        try {
          const content = await fs.readFile(
            path.join(ctx.workDir, 'docs/research-proposal.md'),
            'utf-8'
          );
          const charCount = content.length;
          const passed = charCount >= 800 && charCount <= 2000;
          return {
            passed,
            validation: { type: 'custom' },
            message: passed
              ? `提案长度合适 (${charCount} 字符)`
              : `提案长度不符合要求 (${charCount} 字符，期望 800-2000)`,
          };
        } catch {
          return {
            passed: false,
            validation: { type: 'custom' },
            message: '无法读取提案文件',
          };
        }
      },
    },
  ],

  processValidations: [
    {
      type: 'agent-dispatched',
      message: '应调度子 Agent 协作',
    },
  ],

  expectedBehavior: {
    expectedAgents: ['documenter', 'architect'],
    toolCallRange: { min: 2, max: 15 },
  },

  tags: ['agent-benchmark', 'multi-agent', 'research', 'documentation'],
  timeout: 300000,
};

export default MABR01;
