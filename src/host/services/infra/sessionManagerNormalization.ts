import { homedir } from 'node:os';

import type { ModelConfig } from '../../../shared/contract';

const TELEMETRY_RECOVERY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

export function formatTelemetryRecoveredPrompt(content: string): string {
  return `${TELEMETRY_RECOVERY_NOTICE}\n\n${content}`;
}

const TELEMETRY_PROMPT_CORRELATION_WINDOW_MS = 60_000;

function isSameTurnByTimestamp(
  messageTimestamp: number | string | undefined,
  telemetryStartTime: number | string,
): boolean {
  const messageTime = Number(messageTimestamp);
  const telemetryTime = Number(telemetryStartTime);
  return Number.isFinite(messageTime)
    && Number.isFinite(telemetryTime)
    && messageTime <= telemetryTime
    && telemetryTime - messageTime <= TELEMETRY_PROMPT_CORRELATION_WINDOW_MS;
}

function findClosestPromptTurnIndex(
  existingRows: Array<{ timestamp?: number | string }>,
  telemetryStartTime: number | string,
): number {
  let closestIndex = -1;
  let closestTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < existingRows.length; index++) {
    const timestamp = Number(existingRows[index].timestamp);
    if (
      isSameTurnByTimestamp(existingRows[index].timestamp, telemetryStartTime)
      && timestamp > closestTimestamp
    ) {
      closestIndex = index;
      closestTimestamp = timestamp;
    }
  }
  return closestIndex;
}

export function findMissingTelemetryPromptRows<
  T extends { user_prompt: string; start_time: number | string },
>(
  telemetryRows: T[],
  existingRows: Array<{ content: string; timestamp?: number | string }>,
): T[] {
  const unmatchedExistingRows = existingRows.map((row) => ({
    ...row,
    normalizedContent: normalizePromptForBackfill(row.content),
  }));

  return telemetryRows.filter((row) => {
    const key = normalizePromptForBackfill(row.user_prompt);
    const exactMatchIndex = unmatchedExistingRows.findIndex(
      (existing) => existing.normalizedContent === key,
    );
    if (exactMatchIndex >= 0) {
      unmatchedExistingRows.splice(exactMatchIndex, 1);
      return false;
    }

    // telemetry user_prompt is guarded diagnostic data. Its path/PII masking is lossy,
    // so correlate the already-persisted original by turn time before declaring it absent.
    const timestampMatchIndex = findClosestPromptTurnIndex(
      unmatchedExistingRows,
      row.start_time,
    );
    if (timestampMatchIndex >= 0) {
      unmatchedExistingRows.splice(timestampMatchIndex, 1);
      return false;
    }
    return true;
  });
}

// SessionRepository 持久化只存 provider+model（apiKey 不入库）；剥离后让
// SessionManager 返回的内存 session 与 DB 读回（fromRow）语义一致。
export function sanitizeModelConfigForSession(config: ModelConfig): ModelConfig {
  const { apiKey: _omitted, ...rest } = config;
  void _omitted;
  return rest;
}

// 仅本模块内部使用：对外只暴露 findMissingTelemetryPromptRows（导出它会被 knip 死导出棘轮判红）
function normalizePromptForBackfill(content: string): string {
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
