// ============================================================================
// Model Proxy - 模型 API 代理服务
// POST /api/model-proxy
// 为客户端提供模型 API 代理，服务端注入 API Key
//
// Anthropic 特殊处理：
// - 请求：OpenAI 格式 → Anthropic /messages 格式
// - 流式响应：Anthropic SSE → OpenAI SSE 格式
// 客户端始终使用 OpenAI 兼容格式，代理层透明转换
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('ModelProxy');

export const config = {
  maxDuration: 60, // 模型请求可能较慢
};

// 支持的 provider 和对应的 API 配置
const PROVIDERS: Record<string, { baseUrl: string; envKey: string; authHeader: string }> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    authHeader: 'Authorization',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    authHeader: 'Authorization',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    authHeader: 'Authorization',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    authHeader: 'x-api-key',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZHIPU_API_KEY',
    authHeader: 'Authorization',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    authHeader: 'Authorization',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'QWEN_API_KEY',
    authHeader: 'Authorization',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    authHeader: 'Authorization',
  },
};

interface ProxyRequest {
  provider: string;
  endpoint: string; // e.g., '/chat/completions'
  body: unknown;
}

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: string;
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// ============================================================================
// Anthropic 格式转换
// ============================================================================

/**
 * OpenAI messages → Anthropic messages + system
 */
function convertOpenAIToAnthropicMessages(
  messages: OpenAIMessage[]
): { system: string | undefined; messages: Array<{ role: string; content: unknown }> } {
  let system: string | undefined;
  const anthropicMessages: Array<{ role: string; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Anthropic: system 是顶层参数，不在 messages 里
      const text = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as Array<{ text?: string }>).map(c => c.text || '').join('\n');
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // assistant with tool_calls → Anthropic tool_use content blocks
      const content: unknown[] = [];
      // 先加文本部分（如果有）
      if (msg.content) {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) content.push({ type: 'text', text });
      }
      for (const tc of msg.tool_calls) {
        let args: unknown;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: args,
        });
      }
      anthropicMessages.push({ role: 'assistant', content });
      continue;
    }

    if (msg.role === 'tool') {
      // tool result → Anthropic tool_result content block
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }],
      });
      continue;
    }

    // user / assistant 普通消息
    anthropicMessages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: typeof msg.content === 'string' ? msg.content : msg.content,
    });
  }

  return { system, messages: anthropicMessages };
}

/**
 * OpenAI tools → Anthropic tools
 */
function convertOpenAIToAnthropicTools(tools: OpenAITool[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * 构建 Anthropic 请求体
 */
function buildAnthropicRequestBody(openaiBody: Record<string, unknown>): Record<string, unknown> {
  const { system, messages } = convertOpenAIToAnthropicMessages(
    openaiBody.messages as OpenAIMessage[]
  );

  const body: Record<string, unknown> = {
    model: openaiBody.model,
    messages,
    max_tokens: openaiBody.max_tokens ?? 8192,
  };

  if (system) body.system = system;
  if (openaiBody.temperature !== undefined) body.temperature = openaiBody.temperature;
  if (openaiBody.stream) body.stream = true;

  // 工具
  if (openaiBody.tools && (openaiBody.tools as unknown[]).length > 0) {
    body.tools = convertOpenAIToAnthropicTools(openaiBody.tools as OpenAITool[]);
    // Anthropic tool_choice: auto
    if (openaiBody.tool_choice === 'auto') {
      body.tool_choice = { type: 'auto' };
    }
  }

  return body;
}

/**
 * Anthropic 流式 SSE → OpenAI 流式 SSE
 * 逐行解析 Anthropic 事件，转换后写入 res
 */
async function streamAnthropicToOpenAI(
  anthropicResponse: Response,
  res: VercelResponse
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const reader = anthropicResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 跟踪当前 tool_use block 的 index（用于 OpenAI 格式的 tool_calls[index]）
  let toolCallIndex = -1;
  // 映射 content block index → tool call index
  const blockToToolIndex = new Map<number, number>();

  const writeOpenAIChunk = (delta: Record<string, unknown>, finishReason?: string | null) => {
    const chunk = {
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason || null,
      }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) continue;

        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;

        let data: Record<string, unknown>;
        try { data = JSON.parse(dataStr); } catch { continue; }

        switch (currentEvent) {
          case 'content_block_start': {
            const block = data.content_block as { type: string; id?: string; name?: string };
            const blockIndex = data.index as number;
            if (block?.type === 'tool_use') {
              toolCallIndex++;
              blockToToolIndex.set(blockIndex, toolCallIndex);
              writeOpenAIChunk({
                tool_calls: [{
                  index: toolCallIndex,
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: '' },
                }],
              });
            }
            break;
          }

          case 'content_block_delta': {
            const delta = data.delta as { type: string; text?: string; partial_json?: string };
            const blockIndex = data.index as number;
            if (delta?.type === 'text_delta' && delta.text) {
              writeOpenAIChunk({ content: delta.text });
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              const idx = blockToToolIndex.get(blockIndex) ?? 0;
              writeOpenAIChunk({
                tool_calls: [{
                  index: idx,
                  function: { arguments: delta.partial_json },
                }],
              });
            }
            break;
          }

          case 'message_delta': {
            const msgDelta = data.delta as { stop_reason?: string };
            if (msgDelta?.stop_reason) {
              const reason = msgDelta.stop_reason === 'end_turn' ? 'stop'
                : msgDelta.stop_reason === 'tool_use' ? 'tool_calls'
                : msgDelta.stop_reason;
              writeOpenAIChunk({}, reason);
            }
            break;
          }

          case 'message_stop':
            res.write('data: [DONE]\n\n');
            break;

          case 'error': {
            logger.error('Anthropic stream error', undefined, { data: JSON.stringify(data) });
            // 转发错误
            res.write(`data: ${JSON.stringify({ error: data })}\n\n`);
            res.write('data: [DONE]\n\n');
            break;
          }
        }

        currentEvent = '';
      }
    }
  } catch (err) {
    logger.error('Anthropic stream processing error', err as Error);
  } finally {
    res.end();
  }
}

/**
 * Anthropic 非流式响应 → OpenAI 格式
 */
function convertAnthropicResponseToOpenAI(data: Record<string, unknown>): Record<string, unknown> {
  const content = data.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;

  let textContent = '';
  const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];

  for (const block of content || []) {
    if (block.type === 'text' && block.text) {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || '',
        type: 'function',
        function: {
          name: block.name || '',
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textContent || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const stopReason = data.stop_reason as string;
  const finishReason = stopReason === 'end_turn' ? 'stop'
    : stopReason === 'tool_use' ? 'tool_calls'
    : stopReason || 'stop';

  return {
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: data.usage,
    model: data.model,
  };
}

// ============================================================================
// Main Handler
// ============================================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { provider, endpoint, body } = req.body as ProxyRequest;

  if (!provider || !endpoint || !body) {
    return res.status(400).json({
      error: 'Missing required fields: provider, endpoint, body',
    });
  }

  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) {
    return res.status(400).json({
      error: `Unsupported provider: ${provider}. Supported: ${Object.keys(PROVIDERS).join(', ')}`,
    });
  }

  // 从环境变量获取 API Key
  const apiKey = process.env[providerConfig.envKey];
  if (!apiKey) {
    logger.error('Missing API key for provider', undefined, { provider });
    return res.status(500).json({
      error: `API key not configured for provider: ${provider}`,
    });
  }

  const requestBody = body as Record<string, unknown>;
  const isStreaming = requestBody.stream === true;

  logger.info('Proxying request', { provider, endpoint, streaming: isStreaming });

  try {
    // ── Anthropic 特殊路径 ──────────────────────────────────────────
    if (provider === 'anthropic') {
      return await handleAnthropicProxy(apiKey, requestBody, isStreaming, res);
    }

    // ── OpenAI 兼容路径（其他 provider）────────────────────────────
    const url = `${providerConfig.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (providerConfig.authHeader === 'Authorization') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers[providerConfig.authHeader] = apiKey;
    }

    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://code-agent.app';
      headers['X-Title'] = 'Code Agent';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // 流式响应：直接转发
    if (isStreaming && response.body) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (streamError) {
        logger.error('Stream error', streamError as Error);
      } finally {
        res.end();
      }
      return;
    }

    // 非流式响应
    const contentType = response.headers.get('content-type') || '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return res.status(response.status).json(data);
  } catch (error: unknown) {
    const err = error as Error;
    logger.error('Proxy request failed', err);
    return res.status(500).json({
      error: err.message || 'Proxy request failed',
    });
  }
}

/**
 * Anthropic 专用代理：格式转换 + 流式转发
 */
async function handleAnthropicProxy(
  apiKey: string,
  openaiBody: Record<string, unknown>,
  isStreaming: boolean,
  res: VercelResponse
): Promise<void> {
  const anthropicBody = buildAnthropicRequestBody(openaiBody);
  const url = 'https://api.anthropic.com/v1/messages';

  logger.info('Anthropic proxy', {
    model: anthropicBody.model,
    streaming: isStreaming,
    hasTools: !!(anthropicBody.tools as unknown[] | undefined)?.length,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Anthropic API error', undefined, { status: response.status, body: errorText });
    res.status(response.status).json({
      error: `Anthropic API error: ${response.status} - ${errorText}`,
    });
    return;
  }

  // 流式：Anthropic SSE → OpenAI SSE
  if (isStreaming && response.body) {
    await streamAnthropicToOpenAI(response, res);
    return;
  }

  // 非流式：转换响应格式
  const data = await response.json() as Record<string, unknown>;
  const openaiResponse = convertAnthropicResponseToOpenAI(data);
  res.status(200).json(openaiResponse);
}
