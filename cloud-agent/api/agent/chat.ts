// ============================================================================
// Agent Chat API - 云端 Agent 聊天入口
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateRequest } from '../../lib/auth';
import { CloudAgentLoop, type AgentRequest } from '../../lib/agent/CloudAgentLoop';

export const config = {
  maxDuration: 60, // Vercel Pro plan 最大 60 秒
};

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

  // 验证用户（可选，允许匿名使用）
  const authPayload = await authenticateRequest(req.headers.authorization);

  // 如果配置了必须登录，检查认证
  if (process.env.REQUIRE_AUTH === 'true' && !authPayload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body as AgentRequest;

  if (!body.messages || body.messages.length === 0) {
    return res.status(400).json({ error: 'Messages are required' });
  }

  try {
    const agentLoop = new CloudAgentLoop();

    // 检查是否请求流式响应
    const wantStream = req.headers.accept === 'text/event-stream' || body.stream;

    if (wantStream) {
      // 流式响应
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      for await (const event of agentLoop.stream(body)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);

        if (event.type === 'done' || event.type === 'error') {
          break;
        }
      }

      res.end();
    } else {
      // 非流式响应
      const result = await agentLoop.run(body);

      return res.status(200).json({
        success: true,
        content: result,
        userId: authPayload?.userId,
      });
    }
  } catch (error: any) {
    console.error('Agent chat error:', error);
    return res.status(500).json({
      error: 'Agent execution failed',
      message: error.message,
    });
  }
}
