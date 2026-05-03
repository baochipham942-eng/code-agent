// ============================================================================
// Stagnation Detector — 检测工具调用进入死循环并提示模型换路径
//
// 失败模式（来自 27-turn xiaohongshu session 实战）：
//   - 模型反复用同一工具 + 同样参数打同一 URL，每次都拿到同样的反爬响应
//   - 没有任何止损机制，直到 max_iterations 才停
//   - 实际烧 ~675k input tokens
//
// 检测策略：
//   - 每次 tool call 完成后计算 fingerprint = sha256(name + args + result_summary).slice(0,12)
//   - 维护最近 N 个 fingerprint
//   - 连续 STAGNATION_THRESHOLD 个相同 → 视为 stagnation
//   - 首次命中注入 system 提示，提示"你正在重复，请换方案"
//   - 如果 warning 后仍继续同一 fingerprint，就停止本轮，避免继续烧 token
// ============================================================================

import { createHash } from 'crypto';
import type { ToolCall, ToolResult } from '../../../shared/contract';

/** 最近多少次 tool call 内出现连续相同就触发 */
export const STAGNATION_WINDOW = 5;

/** 连续相同多少次触发 stagnation */
export const STAGNATION_THRESHOLD = 3;

function summarizeOutput(result: ToolResult): string {
  // 取 output 头 200 字符 + error 头 100 字符做 hash 输入。
  // 太短容易误判（小红书反爬框架 HTML 都长得一模一样，应该被捕获）；
  // 太长容易漏判（响应中含时间戳、随机 nonce 时永远不同 hash）。
  const out = typeof result.output === 'string' ? result.output.slice(0, 200) : '';
  const err = typeof result.error === 'string' ? result.error.slice(0, 100) : '';
  return `${out}|${err}|${result.success ? 'ok' : 'err'}`;
}

function countTailRun(fingerprints: string[]): { fingerprint?: string; count: number } {
  if (fingerprints.length === 0) {
    return { count: 0 };
  }

  const last = fingerprints[fingerprints.length - 1];
  let count = 1;
  for (let i = fingerprints.length - 2; i >= 0; i--) {
    if (fingerprints[i] === last) count++;
    else break;
  }

  return { fingerprint: last, count };
}

/**
 * 计算单次 tool call 的 fingerprint（短 hash）。
 * 同 name + 同 args + 同 result 摘要 → 同 fingerprint。
 */
export function fingerprintToolCall(tc: ToolCall, result: ToolResult): string {
  const argsStr = tc.arguments ? JSON.stringify(tc.arguments) : '';
  const resultStr = summarizeOutput(result);
  return createHash('sha256')
    .update(`${tc.name}|${argsStr}|${resultStr}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * 把本轮 tool call 的 fingerprints 推进窗口，返回 stagnation 判定。
 * - detected: 是否命中 stagnation
 * - sameFingerprint: 重复的 fingerprint 值（用于日志）
 * - matchCount: 连续相同次数
 */
export function pushAndDetectStagnation(
  recent: string[],
  newFingerprints: string[],
): {
  detected: boolean;
  sameFingerprint?: string;
  matchCount: number;
  previousMatchCount: number;
  shouldStop: boolean;
} {
  const previousTail = countTailRun(recent);

  // 推入新 fingerprint，超过窗口大小则丢最旧的
  for (const fp of newFingerprints) {
    recent.push(fp);
    while (recent.length > STAGNATION_WINDOW) recent.shift();
  }

  if (recent.length < STAGNATION_THRESHOLD) {
    return { detected: false, matchCount: 0, previousMatchCount: previousTail.count, shouldStop: false };
  }

  const { fingerprint: last, count } = countTailRun(recent);

  if (count >= STAGNATION_THRESHOLD) {
    const shouldStop = (
      previousTail.fingerprint === last &&
      previousTail.count >= STAGNATION_THRESHOLD
    );
    return {
      detected: true,
      sameFingerprint: last,
      matchCount: count,
      previousMatchCount: previousTail.fingerprint === last ? previousTail.count : 0,
      shouldStop,
    };
  }

  return {
    detected: false,
    matchCount: count,
    previousMatchCount: previousTail.fingerprint === last ? previousTail.count : 0,
    shouldStop: false,
  };
}

/**
 * 给模型的 system 提示文本（注入到 conversation 让下一轮看见）。
 * 措辞：明确指出循环 + 建议路径，给模型一次自我纠正机会。
 */
export function buildStagnationHint(matchCount: number): string {
  return (
    `<stagnation-detected>\n` +
    `You have called the same tool with the same arguments and gotten essentially the same result ${matchCount} times in a row. ` +
    `Retrying with minor variations on the same approach will not change the outcome.\n\n` +
    `Try one of these instead:\n` +
    `- Use a different tool entirely (check <env-capabilities> for local CLIs you can invoke via Bash)\n` +
    `- Probe the environment with \`which <cli>\` or \`<cli> --help\` to discover alternatives\n` +
    `- Reconsider the task — is the URL/path correct? Is this site/resource actually fetchable?\n` +
    `- If you genuinely cannot make progress, tell the user the limitation honestly rather than fabricating a plausible-looking answer.\n` +
    `</stagnation-detected>`
  );
}

export function buildStagnationStopMessage(matchCount: number, fingerprint?: string): string {
  const fingerprintText = fingerprint ? ` fingerprint=${fingerprint}` : '';
  return `Tool stagnation detected again after warning: ${matchCount} consecutive identical tool+args+result calls${fingerprintText}. Stopping the agent loop to avoid wasting tokens.`;
}
