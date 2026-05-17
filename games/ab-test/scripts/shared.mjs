// 共享：Mimo SSE 流式调用、prompt 构造、文件落盘
// 关键修复: thinking-mode 模型一次性返回的总耗时常超过 socket idle timeout,
//          必须用 stream=true 让代理/服务器持续看到字节流, 否则连接会被 Clash/mimo 断开。
import fs from 'node:fs/promises';
import path from 'node:path';

export const MIMO_URL = 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions';
export const MIMO_KEY = 'tp-scxq2b7kok5fb5xar1cvgwr89xnwdze0qbdz9wme40kwew92';
export const MIMO_MODEL = 'mimo-v2.5-pro';
export const TEMPERATURE = 0.3;

// 统一用户 prompt — A1 / A2 共用，保证公平
export const USER_PROMPT = `做一个火柴人风格的 2D 平台跳跃游戏：
- 火柴人主角，黑线条卡通画风（不要瘦线小人那种偷工减料）
- 3 个关卡场景，依次推进
- 移动用 ← → 方向键，跳跃用 Space 或 ↑
- 必须有以下机制（缺一不可）：
  1. stomp 敌人（从上方踩扁，触发反弹）
  2. bump 问号砖（从下方顶撞，砖块标记 used，掉落奖励）
  3. 二段跳能力（在 bump 问号砖之后才解锁）
  4. 二段跳能力门：原本够不到的高处路线，拿到二段跳后能上去
- 画面要看得出是游戏，有 HUD 显示得分/血量/能力状态
- 死亡或通关要有明显反馈`;

export async function callMimo({ system, user, maxTokens = 32768, timeout = 900_000, onProgress, enableThinking = false }) {
  // 关键: enable_thinking=false 让 mimo 跳过冗长 reasoning,把 token 预算留给真实 content。
  //       一次性请求/普通流式都会把 reasoning + content 算进 max_tokens; thinking 模型默认会推理上万 token,
  //       直接吃光预算导致 content=0、finish_reason=length。
  const body = {
    model: MIMO_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: TEMPERATURE,
    max_tokens: maxTokens,
    stream: true,
    enable_thinking: enableThinking,
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);

  const { ProxyAgent } = await import('undici');
  const dispatcher = new ProxyAgent({
    uri: 'http://127.0.0.1:7897',
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    bodyTimeout: timeout,
    headersTimeout: 120_000,
  });

  const started = Date.now();
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let chunks = 0;

  try {
    const res = await fetch(MIMO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MIMO_KEY}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Mimo ${res.status}: ${txt.slice(0, 500)}`);
    }
    if (!res.body) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta || {};
          if (typeof delta.content === 'string') content += delta.content;
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
          if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
          if (j.usage) usage = j.usage;
          chunks++;
          if (onProgress && chunks % 50 === 0) {
            onProgress({ contentLen: content.length, reasoningLen: reasoning.length });
          }
        } catch {
          // ignore malformed chunk
        }
      }
    }
  } finally {
    clearTimeout(t);
  }

  return { content, reasoning, usage, finishReason, elapsedMs: Date.now() - started, chunks };
}

export function stripCodeFence(text, lang) {
  const trimmed = text.trim();
  const fence = lang
    ? new RegExp('^```' + lang + '\\s*\\n([\\s\\S]*?)\\n```\\s*$')
    : /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n```\s*$/;
  const m = trimmed.match(fence);
  return m ? m[1] : trimmed;
}

export async function writeJsonFiles(rootDir, filesArray) {
  for (const f of filesArray) {
    const full = path.join(rootDir, f.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.content, 'utf8');
  }
}
