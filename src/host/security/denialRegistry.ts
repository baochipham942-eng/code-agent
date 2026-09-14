// ============================================================================
// Denial Registry - 跨 agent 否认登记与权限洗白匹配（ADR-067 D4）
// ----------------------------------------------------------------------------
// 场景：agent A 的写/执行动作被人在审批卡上拒绝（ask-denied）后，同会话内任何
// agent 再以同一动作指纹出现——peer 消息转述 = 权限洗白，直接 BLOCK；用户本人
// 重试 = forceConfirm 一次（走既有审批记忆，不硬毙）。
//
// 键 = (sessionId, 动作指纹)：同 session 跨 agent 共享（这正是洗白面），
// 跨 session 不共享。指纹规范化复用现成真源，不造第二套：
// - bash 命令：canonicalizeCommand（命令策略/拒绝匹配的唯一文本形），分词后单空格
//   拼接——引号/空白等同义改写同指纹，改参异形不同指纹；静态不可解析不登记
//   （该路径本来就 agent 无关地 fail-closed）。
// - external 出站（邮件/IM）：extractStandingGrantTarget 的收件人集合规范化。
// - 文件路径类：path.resolve(cwd, raw) 归一；cwd 不同的相对路径天然不同指纹
//   （保守方向：漏匹配 > 误伤）。
// ============================================================================

import nodePath from 'path';
import { canonicalizeCommand } from './canonicalizeCommand';
import { isBashToolName } from '../tools/toolNames';
import { extractStandingGrantTarget } from '../tools/externalSideEffect';

/** 计算动作指纹；无法规范化的工具形状返回 null（不进登记、不进匹配）。 */
export function computeActionFingerprint(
  toolName: string,
  params: Record<string, unknown>,
  workingDirectory: string,
): string | null {
  if (isBashToolName(toolName) && typeof params.command === 'string') {
    const canonical = canonicalizeCommand(params.command);
    if (canonical.parsingFailed) return null;
    const words = canonical.command.split(/\s+/).filter(Boolean).join(' ');
    return words ? `bash:${words}` : null;
  }
  const rawPath = params.file_path ?? params.path;
  if (typeof rawPath === 'string' && rawPath) {
    return `file:${toolName}:${nodePath.resolve(workingDirectory, rawPath)}`;
  }
  const target = extractStandingGrantTarget(toolName, params);
  if (target) return `external:${toolName}:${target}`;
  return null;
}

export interface DenialRecord {
  sessionId: string;
  fingerprint: string;
  toolName: string;
  summary: string;
  reason: string;
  timestamp: number;
}

/**
 * 容量有界：每 session FIFO 50 条（沿用 decisionHistory 50 环的既有证明容量），
 * session 表本身 FIFO 20 个——桌面长进程里跨 session 内存有界；跨 session 不共享
 * 是 ADR 的键设计，不是容量妥协。
 */
const MAX_SESSIONS = 20;
const MAX_PER_SESSION = 50;

class DenialRegistry {
  private sessions = new Map<string, Map<string, DenialRecord>>();

  record(entry: DenialRecord): void {
    let bucket = this.sessions.get(entry.sessionId);
    if (!bucket) {
      bucket = new Map();
      this.sessions.set(entry.sessionId, bucket);
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    // 重插刷新 FIFO 序（同指纹重复被拒 = 最新一条有效）
    bucket.delete(entry.fingerprint);
    bucket.set(entry.fingerprint, entry);
    if (bucket.size > MAX_PER_SESSION) {
      const oldest = bucket.keys().next().value;
      if (oldest !== undefined) bucket.delete(oldest);
    }
  }

  find(sessionId: string, fingerprint: string): DenialRecord | undefined {
    return this.sessions.get(sessionId)?.get(fingerprint);
  }

  /** 同一指纹其后被人批准（ask-approved）时调用：洗白信号复位，恢复正常判定。 */
  clear(sessionId: string, fingerprint: string): void {
    const bucket = this.sessions.get(sessionId);
    if (!bucket) return;
    bucket.delete(fingerprint);
    if (bucket.size === 0) this.sessions.delete(sessionId);
  }

  clearAll(): void {
    this.sessions.clear();
  }
}

let instance: DenialRegistry | null = null;

export function getDenialRegistry(): DenialRegistry {
  if (!instance) {
    instance = new DenialRegistry();
  }
  return instance;
}

export function resetDenialRegistry(): void {
  instance = null;
}
