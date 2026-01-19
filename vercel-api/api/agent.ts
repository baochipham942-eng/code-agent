// ============================================================================
// Agent API - 统一 Agent 接口
// POST /api/agent?action=chat  - 云端 Agent 聊天
// POST /api/agent?action=plan  - 生成执行计划
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../lib/auth.js';
import { CloudAgentLoop, type AgentRequest, type CloudAgentConfig } from '../lib/agent/CloudAgentLoop.js';
import { setCorsHeaders, handleOptions, applyRateLimit, handleError } from '../lib/middleware.js';
import { RATE_LIMITS } from '../lib/rateLimit.js';
import { getApiKey, type ApiKeyType } from '../lib/apiKeys.js';

export const config = {
  maxDuration: 60,
};

/**
 * 获取 Agent 配置（根据用户权限和可用 Key）
 * 权限规则：
 * - 管理员：使用系统 Key（环境变量）
 * - 普通用户：只能使用自己在客户端配置的 Key
 * - 未登录用户：无权访问
 * 模型优先级：DeepSeek > OpenAI > Anthropic
 */
async function getAgentConfig(userId?: string): Promise<CloudAgentConfig | null> {
  // 未登录用户无法使用 Agent
  if (!userId) {
    return null;
  }

  // 按优先级尝试获取 API Key
  const providers: Array<{ type: ApiKeyType; provider: 'deepseek' | 'openai' | 'anthropic' }> = [
    { type: 'deepseek', provider: 'deepseek' },
    { type: 'openai', provider: 'openai' },
    { type: 'anthropic', provider: 'anthropic' },
  ];

  for (const { type, provider } of providers) {
    try {
      // getApiKey 内部已实现权限逻辑：
      // - 管理员：优先返回系统 Key
      // - 普通用户：只返回自己配置的 Key
      const keyResult = await getApiKey(userId, type);
      if (keyResult) {
        console.log(`[Agent] Using ${provider} key from ${keyResult.source} for user ${userId}`);
        return {
          provider,
          apiKey: keyResult.key,
          maxTokens: 4096,
          temperature: 0.7,
        };
      }
    } catch (err) {
      console.error(`[Agent] Failed to get ${type} API key:`, err);
    }
  }

  return null;
}

// Chat 处理
async function handleChat(req: VercelRequest, res: VercelResponse, userId?: string) {
  const body = req.body as AgentRequest & { stream?: boolean };

  if (!body.messages || body.messages.length === 0) {
    return res.status(400).json({ error: 'Messages are required' });
  }

  if (!userId) {
    return res.status(401).json({
      error: 'Authentication required',
      message: '请先登录后再使用 Agent 功能',
    });
  }

  const agentConfig = await getAgentConfig(userId);

  if (!agentConfig) {
    return res.status(403).json({
      error: 'No API key available',
      message: '请在设置中配置你的 API Key（支持 DeepSeek/OpenAI/Anthropic）',
    });
  }

  const agentLoop = new CloudAgentLoop(agentConfig);
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
    return res.status(200).json({
      success: true,
      content: result,
      provider: agentConfig.provider,
      userId,
    });
  }
}

// Plan 处理
async function handlePlan(req: VercelRequest, res: VercelResponse, userId?: string) {
  const { task, projectSummary, fileTree, constraints } = req.body;

  if (!task) {
    return res.status(400).json({ error: 'Task description is required' });
  }

  if (!userId) {
    return res.status(401).json({
      error: 'Authentication required',
      message: '请先登录后再使用 Plan 功能',
    });
  }

  const agentConfig = await getAgentConfig(userId);

  if (!agentConfig) {
    return res.status(403).json({
      error: 'No API key available',
      message: '请在设置中配置你的 API Key（支持 DeepSeek/OpenAI/Anthropic）',
    });
  }

  const agentLoop = new CloudAgentLoop(agentConfig);

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
    return res.status(200).json({
      success: true,
      plan,
      provider: agentConfig.provider,
      userId,
    });
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
