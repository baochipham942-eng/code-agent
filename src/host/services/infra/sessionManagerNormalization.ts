import { homedir } from 'node:os';

import type { ModelConfig } from '../../../shared/contract';

// SessionRepository 持久化只存 provider+model（apiKey 不入库）；剥离后让
// SessionManager 返回的内存 session 与 DB 读回（fromRow）语义一致。
export function sanitizeModelConfigForSession(config: ModelConfig): ModelConfig {
  const { apiKey: _omitted, ...rest } = config;
  void _omitted;
  return rest;
}

export function normalizePromptForBackfill(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .trim()
    // 消息表可能已把 ~/ 展开成绝对主目录，而 telemetry 保留模型原文。
    .replace(/~\//g, `${homedir()}/`)
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/giu, (rawUrl) => {
      // 两侧统一走 WHATWG URL canonicalization；解析失败则保持原文。
      try {
        return new URL(rawUrl).toString();
      } catch {
        return rawUrl;
      }
    });
}
