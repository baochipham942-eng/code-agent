// ============================================================================
// Agent API - 统一 Agent 接口
// POST /api/agent?action=chat  - 云端 Agent 聊天
// POST /api/agent?action=plan  - 生成执行计划
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../lib/auth.js';
import { CloudAgentLoop, type AgentRequest } from '../lib/agent/CloudAgentLoop.js';
import { setCorsHeaders, handleOptions, applyRateLimit, handleError } from '../lib/middleware.js';
import { RATE_LIMITS } from '../lib/rateLimit.js';
import { getApiKey } from '../lib/apiKeys.js';

export const config = {
  maxDuration: 60,
};

// Chat 处理
async function handleChat(req: VercelRequest, res: VercelResponse, userId?: string) {
  const body = req.body as AgentRequest & { stream?: boolean };

  if (!body.messages || body.messages.length === 0) {
    return res.status(400).json({ error: 'Messages are required' });
  }

  // 获取用户的 API Key（优先用户配置，管理员可用系统 Key）
  let apiKey: string | undefined;

  // 首先尝试从环境变量获取系统 Key
  apiKey = process.env.ANTHROPIC_API_KEY;

  // 如果有登录用户，尝试获取用户配置的 Key（优先级更高）
  if (userId) {
    try {
      const keyResult = await getApiKey(userId, 'anthropic');
      if (keyResult) {
        apiKey = keyResult.key;
      }
    } catch (err) {
      // 数据库查询失败，使用系统 Key
      console.error('[Agent] Failed to get user API key:', err);
    }
  }

  if (!apiKey) {
    return res.status(403).json({
      error: 'No API key available',
      message: '请在设置中配置 Anthropic API Key，或联系管理员',
    });
  }

  const agentLoop = new CloudAgentLoop(apiKey);
  const wantStream = req.headers.accept === 'text/event-stream' || body.stream;

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const event of agentLoop.stream(body)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') break;
    }
    res.end();
  } else {
    const result = await agentLoop.run(body);
    return res.status(200).json({ success: true, content: result, userId });
  }
}

// Plan 处理
async function handlePlan(req: VercelRequest, res: VercelResponse, userId?: string) {
  const { task, projectSummary, fileTree, constraints } = req.body;

  if (!task) {
    return res.status(400).json({ error: 'Task description is required' });
  }

  // 获取用户的 API Key
  let apiKey: string | undefined;

  // 首先尝试从环境变量获取系统 Key
  apiKey = process.env.ANTHROPIC_API_KEY;

  // 如果有登录用户，尝试获取用户配置的 Key
  if (userId) {
    try {
      const keyResult = await getApiKey(userId, 'anthropic');
      if (keyResult) {
        apiKey = keyResult.key;
      }
    } catch (err) {
      console.error('[Agent] Failed to get user API key:', err);
    }
  }

  if (!apiKey) {
    return res.status(403).json({
      error: 'No API key available',
      message: '请在设置中配置 Anthropic API Key，或联系管理员',
    });
  }

  const agentLoop = new CloudAgentLoop(apiKey);

  const planPrompt = `你是一个任务规划专家。请为以下任务生成一个详细的执行计划。

## 任务
${task}

${projectSummary ? `## 项目概要\n${projectSummary}` : ''}
${fileTree?.length ? `## 文件结构\n${fileTree.slice(0, 30).join('\n')}` : ''}
${constraints?.length ? `## 约束条件\n${constraints.map((c: string) => `- ${c}`).join('\n')}` : ''}

## 要求
请生成一个客户端可执行的计划，返回 JSON 格式：

{
  "task": "任务简述",
  "steps": [
    { "id": 1, "action": "操作描述", "tool": "工具名称", "params": {}, "description": "说明", "dependsOn": [] }
  ],
  "estimatedSteps": 5,
  "warnings": []
}

可用工具: read_file, write_file, edit_file, bash, glob, grep
只返回 JSON。`;

  const result = await agentLoop.run({
    messages: [{ role: 'user', content: planPrompt }],
    maxTokens: 4096,
  });

  try {
    const jsonMatch = result.match(/```json\n?([\s\S]*?)\n?```/) || [null, result];
    const plan = JSON.parse(jsonMatch[1] || result);
    return res.status(200).json({ success: true, plan, userId });
  } catch {
    return res.status(500).json({ error: 'Failed to parse plan', raw: result });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS - 限制允许的来源
  setCorsHeaders(req, res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 验证用户（可选）
  const authPayload = await authenticateRequest(req.headers.authorization);
  if (process.env.REQUIRE_AUTH === 'true' && !authPayload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Rate limiting
  if (applyRateLimit(req, res, authPayload?.userId, RATE_LIMITS.agent)) return;

  const action = req.query.action as string;

  try {
    switch (action) {
      case 'chat':
        return handleChat(req, res, authPayload?.userId);
      case 'plan':
        return handlePlan(req, res, authPayload?.userId);
      default:
        return res.status(400).json({ error: 'Invalid action. Use: chat, plan' });
    }
  } catch (err) {
    handleError(res, err, 'Agent operation failed');
  }
}
