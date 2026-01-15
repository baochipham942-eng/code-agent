// ============================================================================
// Agent Plan API - 生成客户端可执行的计划
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../../lib/auth';
import { CloudAgentLoop } from '../../lib/agent/CloudAgentLoop';

export const config = {
  maxDuration: 30,
};

interface PlanRequest {
  task: string;
  projectSummary?: string;
  fileTree?: string[];
  constraints?: string[];
}

interface PlanStep {
  id: number;
  action: string;
  tool: string;
  params: Record<string, unknown>;
  description: string;
  dependsOn?: number[];
}

interface ExecutionPlan {
  task: string;
  steps: PlanStep[];
  estimatedSteps: number;
  warnings?: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 验证用户
  const authPayload = await authenticateRequest(req.headers.authorization);

  if (process.env.REQUIRE_AUTH === 'true' && !authPayload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body as PlanRequest;

  if (!body.task) {
    return res.status(400).json({ error: 'Task description is required' });
  }

  try {
    const agentLoop = new CloudAgentLoop();

    const planPrompt = `你是一个任务规划专家。请为以下任务生成一个详细的执行计划。

## 任务
${body.task}

${body.projectSummary ? `## 项目概要\n${body.projectSummary}` : ''}

${body.fileTree?.length ? `## 文件结构\n${body.fileTree.slice(0, 30).join('\n')}` : ''}

${body.constraints?.length ? `## 约束条件\n${body.constraints.map((c) => `- ${c}`).join('\n')}` : ''}

## 要求
请生成一个客户端可执行的计划，返回 JSON 格式：

{
  "task": "任务简述",
  "steps": [
    {
      "id": 1,
      "action": "操作描述",
      "tool": "工具名称 (read_file|write_file|edit_file|bash|glob|grep)",
      "params": { "工具参数" },
      "description": "这一步做什么",
      "dependsOn": []  // 依赖的步骤 ID
    }
  ],
  "estimatedSteps": 5,
  "warnings": ["可能的风险或注意事项"]
}

可用的客户端工具：
- read_file: 读取文件 { path: string }
- write_file: 写入文件 { path: string, content: string }
- edit_file: 编辑文件 { path: string, oldText: string, newText: string }
- bash: 执行命令 { command: string }
- glob: 搜索文件 { pattern: string, cwd?: string }
- grep: 搜索内容 { pattern: string, path?: string }

只返回 JSON，不要其他内容。`;

    const result = await agentLoop.run({
      messages: [{ role: 'user', content: planPrompt }],
      maxTokens: 4096,
    });

    // 尝试解析 JSON
    let plan: ExecutionPlan;
    try {
      // 提取 JSON（可能被包裹在 markdown 代码块中）
      const jsonMatch = result.match(/```json\n?([\s\S]*?)\n?```/) || [null, result];
      plan = JSON.parse(jsonMatch[1] || result);
    } catch {
      return res.status(500).json({
        error: 'Failed to parse plan',
        raw: result,
      });
    }

    return res.status(200).json({
      success: true,
      plan,
      userId: authPayload?.userId,
    });
  } catch (error: any) {
    console.error('Plan generation error:', error);
    return res.status(500).json({
      error: 'Plan generation failed',
      message: error.message,
    });
  }
}
