import { homedir } from 'node:os';

import type { ModelConfig } from '../../../shared/contract';

const TELEMETRY_RECOVERY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

export function formatTelemetryRecoveredPrompt(content: string): string {
  return `${TELEMETRY_RECOVERY_NOTICE}\n\n${content}`;
}

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
