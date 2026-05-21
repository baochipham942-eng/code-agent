// ============================================================================
// OpenAI-Compatible SSE Stream Handler
// 共享的 SSE 流式解析逻辑，消除 4 个 provider 的重复代码
// ============================================================================

import https from 'https';
import http from 'http';
import { StringDecoder } from 'string_decoder';
import { type ModelResponse, type StreamCallback, type ResponseContentPart, ContextLengthExceededError } from '../types';
import { logger, getHttpsAgent, parseContextLengthError, buildToolCallFromAccumulator, safeJsonStringify } from './shared';
import { parseOpenAIStreamChunk } from './wrappers/openaiWrapper';
import { PROVIDER_TIMEOUT, SSE_FIRST_BYTE_TIMEOUT, SSE_INACTIVITY_TIMEOUT } from '../../../shared/constants';

/**
 * 规范化工具名称
 * 部分 OpenAI 兼容代理会在工具名前加 `functions_` 前缀，末尾加 `_N` 数字后缀
 * 例: `functions_AgentSpawn_1` → `AgentSpawn`
 */
function normalizeToolName(name: string): string {
  if (!name) return name;
  let normalized = name;
  // 去掉 functions_ 前缀
  if (normalized.startsWith('functions_')) {
    normalized = normalized.slice('functions_'.length);
  }
  // 去掉末尾 _数字 后缀（仅当前面还有内容时）
  normalized = normalized.replace(/_\d+$/, '');
  return normalized || name; // 防止空串
}


export interface StreamSnapshot {
  /** Accumulated text content so far */
  content: string;
  /** Accumulated reasoning/thinking so far */
  reasoning: string;
  /** Tool calls assembled so far */
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  /** Estimated output tokens */
  estimatedTokens: number;
  /** Snapshot timestamp */
  timestamp: number;
  /** Whether this is the final snapshot (stream completed) */
  isFinal: boolean;
}

export interface SSEStreamOptions {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  requestBody: Record<string, unknown>;
  onStream?: StreamCallback;
  signal?: AbortSignal;
  agent?: https.Agent | http.Agent;
  extraHeaders?: Record<string, string>;
  timeout?: number;
  /** 首字节超时（ms），连接成功后在此时间内未收到任何数据则断开。默认 SSE_FIRST_BYTE_TIMEOUT */
  firstByteTimeout?: number;
  /** Chunk-gap 静默超时（ms）：收到首字节后，两个真正 SSE data 行之间的最大间隔。
   *  默认 SSE_INACTIVITY_TIMEOUT。注释行 (`:`) 和 keep-alive 不会重置该 timer。 */
  inactivityTimeout?: number;
  /** API 路径，默认 '/chat/completions' */
  endpoint?: string;
  /** Periodic snapshot callback for mid-stream persistence. Called every snapshotIntervalMs with accumulated state. */
  onSnapshot?: (snapshot: StreamSnapshot) => void;
  /** Snapshot interval in ms (default: 3000) */
  snapshotIntervalMs?: number;
}

function getIncompleteToolCallIds(
  toolCalls: Iterable<{ id: string; name: string; arguments: string }>,
): string[] {
  const incompleteIds: string[] = [];
  for (const toolCall of toolCalls) {
    if (!toolCall.name || !toolCall.arguments) {
      incompleteIds.push(toolCall.id);
      continue;
    }
    try {
      JSON.parse(toolCall.arguments);
    } catch {
      incompleteIds.push(toolCall.id);
    }
  }
  return incompleteIds;
}

interface NormalizedStreamText {
  next: string;
  delta: string;
}

function appendStreamTextDelta(current: string, incoming: string | null | undefined): NormalizedStreamText {
  if (!incoming) return { next: current, delta: '' };

  // Some OpenAI-compatible providers send cumulative snapshots for reasoning
  // fields even though the wire shape looks like a delta. Treat a long prefix
  // match as a snapshot so we do not poison persisted thinking with repeats.
  if (current.length >= 16) {
    if (incoming === current) return { next: current, delta: '' };
    if (incoming.startsWith(current)) {
      return { next: incoming, delta: incoming.slice(current.length) };
    }
  }

  return { next: current + incoming, delta: incoming };
}

function normalizeLoopSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[.,;:!?，。；：！？、"'“”‘’`()[\]{}（）\s]+/g, '')
    .trim();
}

/**
 * 剥离 content 中残留的 ChatML / Hermes 风格 tool_call XML。
 *
 * Why: 部分 thinking-mode 模型（如 MiMo）在多轮 tool-calling 时偶尔会用
 * `<tool_call><function=NAME><parameter=KEY>VAL</parameter></function></tool_call>`
 * 的 ChatML 字面量格式发起 tool 调用，而非 OpenAI 协议的 delta.tool_calls
 * 结构化字段。这种 XML 文本被 SSE parser 当作普通 content 累积，最终泄露到
 * stdout 污染输出（实测 Task 9 末尾出现）。
 *
 * 处理策略：**只剥离不恢复**——避免误把模型语义不明确的 tool 调用真执行。
 * 实测场景下模型在下一 turn 通常能自己想明白前面已经完成。
 *
 * 如果检测到剥离发生，给一个 warn log 便于追踪频率。
 */
function stripChatMLToolCallResidue(content: string, providerName: string): string {
  if (!content) return content;
  const hasChatMLBlock = /<tool_call>[\s\S]*?<\/tool_call>/.test(content);
  const hasBareFunction = /<function=[^>]+>[\s\S]*?<\/function>/.test(content);
  if (!hasChatMLBlock && !hasBareFunction) return content;

  const originalLength = content.length;
  const cleaned = content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<function=[^>]+>[\s\S]*?<\/function>/g, '')
    .replace(/<parameter=[^>]+>[\s\S]*?<\/parameter>/g, '')
    .replace(/<\/?(tool_call|function|parameter)[^>]*>/g, '')
    .trim();

  logger.warn(`[${providerName}] Stripped ChatML tool_call XML residue from content`, {
    bytesRemoved: originalLength - cleaned.length,
  });
  return cleaned;
}

function detectRepeatedReasoningLoop(text: string): { sentence: string; count: number } | null {
  if (text.length < 240) return null;

  const counts = new Map<string, { raw: string; count: number }>();
  const sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g);
  if (!sentences || sentences.length < 8) return null;

  for (const sentence of sentences) {
    const key = normalizeLoopSentence(sentence);
    if (key.length < 8) continue;
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { raw: sentence.trim(), count: 1 });
    }
  }

  for (const entry of counts.values()) {
    if (entry.count >= 6) {
      return { sentence: entry.raw, count: entry.count };
    }
  }

  return null;
}

/**
 * 通用 OpenAI 兼容 SSE 流式请求处理
 *
 * 支持的特性（自动检测）：
 * - SSE 注释行（`:` 开头，如代理中继的 `: OPENROUTER PROCESSING`）
 * - reasoning_content（DeepSeek R1 / GLM 推理模型）
 * - usage 数据捕获（prompt_tokens / completion_tokens）
 * - 实时 token 估算（每 500ms）
 * - AbortSignal 取消支持
 */
export function openAISSEStream(options: SSEStreamOptions): Promise<ModelResponse> {
  const {
    providerName,
    baseUrl,
    apiKey,
    requestBody,
    onStream,
    signal,
    agent,
    extraHeaders,
    timeout = PROVIDER_TIMEOUT,
    firstByteTimeout = SSE_FIRST_BYTE_TIMEOUT,
    inactivityTimeout = SSE_INACTIVITY_TIMEOUT,
    endpoint = '/chat/completions',
    onSnapshot,
    snapshotIntervalMs,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was cancelled before starting'));
      return;
    }

    // URL 用 try-catch 兜底，畸形 baseUrl/endpoint 走 reject 而非 throw
    let url: URL;
    try {
      url = new URL(`${baseUrl}${endpoint}`);
    } catch (e) {
      return reject(new TypeError(`Invalid baseUrl/endpoint: ${baseUrl}${endpoint}`, { cause: e }));
    }
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // 累积状态
    let content = '';
    let reasoning = '';
    let finishReason: string | undefined;
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let charCount = 0;
    let lastEstimateTime = 0;
    let usageData: { inputTokens: number; outputTokens: number } | undefined;
    // 追踪 content 和 tool_call 的交错顺序
    const contentParts: ResponseContentPart[] = [];
    let lastPartType: 'text' | 'tool_call' | null = null;

    // Stream snapshot state
    let lastSnapshotTime = 0;
    const snapshotInterval = snapshotIntervalMs ?? 3000;

    // Chunk-gap inactivity watchdog state（提到 Promise 顶层以便 signal abort 路径访问）
    let inactivityTimer: NodeJS.Timeout | null = null;
    const clearInactivityTimer = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };

    function emitSnapshot(isFinal: boolean) {
      if (!onSnapshot) return;
      onSnapshot({
        content,
        reasoning,
        toolCalls: Array.from(toolCalls.values()),
        estimatedTokens: Math.ceil(charCount / 4),
        timestamp: Date.now(),
        isFinal,
      });
    }

    const reqOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
        ...extraHeaders,
      },
      agent: agent || getHttpsAgent(url.href),
      timeout,
    };

    const req = httpModule.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          logger.warn(`[${providerName}] API 错误: ${res.statusCode}`, errorData);
          let errorMessage = `${providerName} API 错误 (${res.statusCode})`;
          try {
            // OpenAI/兼容供应商的错误体结构基本一致：{ error: { message, type?, code? } }，
            // 这里只用 message 一个字段。出现非常规 shape 时类型断言失败也只走 catch fallback。
            const parsed = JSON.parse(errorData) as { error?: { message?: string } };
            const innerMsg = parsed.error?.message;
            if (innerMsg) {
              errorMessage = `${providerName} API (${res.statusCode}): ${innerMsg}`;
            }
            // 400 错误诊断：区分 token 超限、无效参数等
            if (res.statusCode === 400) {
              const errLower = (innerMsg || errorData).toLowerCase();
              if (errLower.includes('token') || errLower.includes('context_length') || errLower.includes('max_tokens') || errLower.includes('too long') || errLower.includes('exceeds')) {
                errorMessage = `${providerName}: 上下文 token 超限，建议压缩对话或新开会话。原始错误: ${innerMsg || errorData.substring(0, 200)}`;
              } else if (errLower.includes('invalid') || errLower.includes('parameter') || errLower.includes('required')) {
                errorMessage = `${providerName}: 请求参数无效 — ${innerMsg || errorData.substring(0, 200)}`;
              } else {
                errorMessage = `${providerName}: 请求格式错误 (400) — ${innerMsg || errorData.substring(0, 200)}`;
              }
            }
          } catch {
            errorMessage = `${providerName} API error: ${res.statusCode} - ${errorData.substring(0, 200)}`;
          }
          // Emit error event with diagnostic info
          if (onStream) {
            onStream({
              type: 'error',
              error: errorMessage,
              errorCode: String(res.statusCode),
            });
          }

          // 如果是 token 超限错误，抛出 ContextLengthExceededError 以触发自动压缩
          const ctxError = parseContextLengthError(errorMessage, providerName);
          if (ctxError) {
            reject(ctxError);
          } else {
            reject(new Error(errorMessage));
          }
        });
        return;
      }

      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let receivedFirstByte = false;

      // 阶段 1：HTTP 200 后等首字节
      const firstByteTimer = setTimeout(() => {
        if (!receivedFirstByte) {
          logger.warn(`[${providerName}] First-byte timeout: ${firstByteTimeout}ms 内未收到任何 SSE 数据`);
          req.destroy(new Error(`${providerName} API first-byte timeout (${firstByteTimeout}ms)`));
        }
      }, firstByteTimeout);

      // 阶段 2：首字节后，监控真 SSE data 行的 chunk-gap inactivity。
      // 注释行 (`:`) 和 TCP keep-alive 不会重置该 timer，因为它们不代表"模型在生成"。
      // 触发后 emit error event + req.destroy(error)，由 retryStrategy 接住自动重试。
      const armInactivityTimer = () => {
        clearInactivityTimer();
        inactivityTimer = setTimeout(() => {
          logger.warn(`[${providerName}] Stream inactivity: ${inactivityTimeout}ms 内未收到 SSE data 行，主动 abort`);
          if (onStream) {
            onStream({
              type: 'error',
              error: `${providerName} stream inactivity timeout (${inactivityTimeout}ms)`,
            });
          }
          req.destroy(new Error(`${providerName} stream inactivity timeout (${inactivityTimeout}ms)`));
        }, inactivityTimeout);
      };

      res.on('data', (chunk: Buffer) => {
        if (!receivedFirstByte) {
          receivedFirstByte = true;
          clearTimeout(firstByteTimer);
          armInactivityTimer();
        }
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // 忽略 SSE 注释行
          if (line.startsWith(':')) continue;
          if (!line.trim()) continue;

          // 兼容 "data:" 和 "data: " 两种格式
          if (!line.startsWith('data:')) continue;
          // 真正的 SSE data 行：重置 inactivity timer
          armInactivityTimer();
          const data = line.slice(5).trim();

          if (data === '[DONE]') {
            // 从 content 中提取 <think> 块，合并到 reasoning
            const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
            let thinkMatch;
            while ((thinkMatch = thinkRegex.exec(content)) !== null) {
              reasoning += (reasoning ? '\n' : '') + thinkMatch[1].trim();
            }
            content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            content = stripChatMLToolCallResidue(content, providerName);

            const truncated = finishReason === 'length';
            const result: ModelResponse = {
              type: toolCalls.size > 0 ? 'tool_use' : 'text',
              content: content || undefined,
              truncated,
              finishReason,
              thinking: reasoning || undefined,
              usage: usageData || { inputTokens: 0, outputTokens: Math.ceil(charCount / 4) },
            };

            if (toolCalls.size > 0) {
              result.toolCalls = Array.from(toolCalls.values()).map(buildToolCallFromAccumulator);
            }
            // 只在有交错时才附带 contentParts
            if (contentParts.length > 1 || (contentParts.length === 1 && toolCalls.size > 0 && content)) {
              result.contentParts = contentParts;
            }

            logger.info(`[${providerName}] stream complete:`, {
              contentLength: content.length,
              toolCallCount: toolCalls.size,
              finishReason,
            });

            if (truncated) {
              logger.warn(`[${providerName}] ⚠️ Output was truncated due to max_tokens limit!`);
            }

            // Emit usage event (if data available)
            if (onStream && usageData) {
              onStream({
                type: 'usage',
                inputTokens: usageData.inputTokens,
                outputTokens: usageData.outputTokens,
              });
            }

            // Emit complete event
            if (onStream) {
              onStream({
                type: 'complete',
                finishReason: finishReason || 'stop',
              });
            }

            clearInactivityTimer();
            emitSnapshot(true);
            resolve(result);
            return;
          }

          let rawParsed: unknown;
          try {
            rawParsed = JSON.parse(data);
          } catch {
            logger.debug(`[${providerName}] JSON 解析跳过: ${data.substring(0, 50)}`);
            continue;
          }

          // zod 验证 + 类型 narrow（schema 失败返回 null，hot path 安全降级）
          const chunk = parseOpenAIStreamChunk(rawParsed);
          if (!chunk) continue;

          const choice = chunk.choices?.[0];
          const delta = choice?.delta;

          // 捕获 usage
          if (chunk.usage) {
            usageData = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          // 捕获 finish_reason
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          if (delta) {
            const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
            if (reasoningDelta) {
              const normalized = appendStreamTextDelta(reasoning, reasoningDelta);
              reasoning = normalized.next;
              if (onStream && normalized.delta) {
                onStream({ type: 'reasoning', content: normalized.delta });
              }

              const reasoningLoop = detectRepeatedReasoningLoop(reasoning);
              if (reasoningLoop) {
                const message = `[${providerName}] reasoning loop detected: repeated "${reasoningLoop.sentence.slice(0, 80)}" ${reasoningLoop.count} times`;
                logger.warn(message);
                if (onStream) {
                  onStream({
                    type: 'error',
                    error: message,
                  });
                }
                clearInactivityTimer();
                req.destroy(new Error(message));
                reject(new Error(message));
                return;
              }
            }

            // 文本内容
            const textContent = delta.content;
            if (textContent) {
              const normalized = appendStreamTextDelta(content, textContent);
              content = normalized.next;
              if (normalized.delta) {
                // 追踪交错：从 tool_call 切回 text 时，开始新 text 部分
                if (lastPartType !== 'text') {
                  contentParts.push({ type: 'text', text: '' });
                  lastPartType = 'text';
                }
                // 累积到当前 text part
                const lastPart = contentParts[contentParts.length - 1];
                if (lastPart?.type === 'text') {
                  lastPart.text += normalized.delta;
                }
                charCount += normalized.delta.length;
                if (onStream) {
                  onStream({ type: 'text', content: normalized.delta });
                  // 每 500ms 估算 token 数
                  const now = Date.now();
                  if (now - lastEstimateTime > 500) {
                    lastEstimateTime = now;
                    onStream({
                      type: 'token_estimate',
                      inputTokens: 0,
                      outputTokens: Math.ceil(charCount / 4),
                    });
                  }
                }
              }
            }

            // 工具调用
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;

                if (!toolCalls.has(index)) {
                  const toolCallId = tc.id || `call_${index}`;
                  const toolName = normalizeToolName(tc.function?.name || '');
                  toolCalls.set(index, {
                    id: toolCallId,
                    name: toolName,
                    arguments: '',
                  });
                  // 追踪交错：记录 tool_call 出现位置
                  contentParts.push({ type: 'tool_call', toolCallId });
                  lastPartType = 'tool_call';
                  if (onStream) {
                    onStream({
                      type: 'tool_call_start',
                      toolCall: {
                        index,
                        id: toolCallId,
                        name: toolName,
                      },
                    });
                  }
                }

                const existing = toolCalls.get(index)!;

                if (tc.id && existing.id.startsWith('call_')) {
                  existing.id = tc.id;
                }
                if (tc.function?.name && !existing.name) {
                  existing.name = normalizeToolName(tc.function.name);
                }
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                  if (onStream) {
                    onStream({
                      type: 'tool_call_delta',
                      toolCall: {
                        index,
                        argumentsDelta: tc.function.arguments,
                      },
                    });
                  }
                }
              }
            }
          }
        }

        // Periodic snapshot for mid-stream persistence
        if (onSnapshot && Date.now() - lastSnapshotTime > snapshotInterval) {
          lastSnapshotTime = Date.now();
          emitSnapshot(false);
        }
      });

      res.on('end', () => {
        clearTimeout(firstByteTimer);
        clearInactivityTimer();
        // 从 content 中提取 <think> 块，合并到 reasoning
        const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
        let thinkMatch;
        while ((thinkMatch = thinkRegex.exec(content)) !== null) {
          reasoning += (reasoning ? '\n' : '') + thinkMatch[1].trim();
        }
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        content = stripChatMLToolCallResidue(content, providerName);

        if (content || toolCalls.size > 0) {
          emitSnapshot(false);
          const incompleteToolCallIds = getIncompleteToolCallIds(toolCalls.values());
          if (toolCalls.size > 0) {
            reject(new Error(
              `[${providerName}] stream ended before [DONE] with tool calls; refusing to execute incomplete tool arguments`
              + (incompleteToolCallIds.length > 0 ? ` (${incompleteToolCallIds.join(', ')})` : ''),
            ));
            return;
          }

          const result: ModelResponse = {
            type: 'text',
            content: content || undefined,
            truncated: true,
            finishReason,
            thinking: reasoning || undefined,
            usage: usageData || { inputTokens: 0, outputTokens: Math.ceil(charCount / 4) },
          };

          resolve(result);
        } else {
          reject(new Error(`[${providerName}] 流式响应无内容`));
        }
      });

      res.on('error', (err) => {
        clearTimeout(firstByteTimer);
        clearInactivityTimer();
        logger.warn(`[${providerName}] 响应错误:`, err);
        if (onStream) {
          onStream({
            type: 'error',
            error: err.message,
          });
        }
        reject(err);
      });
    });

    req.on('error', (err) => {
      const errCode = (err as NodeJS.ErrnoException).code;
      logger.warn(`[${providerName}] 请求错误: ${err.message} (code=${errCode})`);
      if (onStream) {
        onStream({
          type: 'error',
          error: err.message,
          errorCode: errCode,
        });
      }
      reject(err);
    });

    req.on('timeout', () => {
      logger.warn(`[${providerName}] 请求超时`);
      req.destroy(new Error(`${providerName} API 请求超时`));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        clearInactivityTimer();
        req.destroy();
        reject(new Error('Request was cancelled'));
      }, { once: true });
    }

    req.write(safeJsonStringify(requestBody));
    req.end();
  });
}
